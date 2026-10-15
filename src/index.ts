import { registerCommand } from "@vendetta/commands";
import { findByName, findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher, React } from "@vendetta/metro/common";
import { after, before } from "@vendetta/patcher";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";
import { findInReactTree } from "@vendetta/utils";

// Resolved inside load() so a failed lookup can never crash plugin startup
let LazyActionSheet: any;
let RowComponent: any;
let TableMod: any;
let PrivateChannelSortStore: any;

const safe = <T,>(fn: () => T): T | undefined => {
    try {
        return fn();
    } catch {
        return undefined;
    }
};

// In-memory only: everything resets when Discord restarts (or the plugin is unloaded)
const hiddenDmIds = new Set<string>();
let showHiddenDms = false;
let debugSheets = false;

const unpatches: (() => void)[] = [];

let ChannelStoreRef: any;
let patchedGetters: string[] = [];

function refreshDmList(channelId?: string) {
    const emit = () => {
        for (const store of [PrivateChannelSortStore, ChannelStoreRef]) {
            safe(() => store?.emitChange?.(null));
            // Also call the subscribed change listeners directly, in case emitChange is deferred
            safe(() => store?._changeCallbacks?.invoke?.());
        }
    };
    emit();

    // emitChange alone doesn't always make the DM list re-render. Re-announcing the channel
    // makes the stores treat it as a real change, so the list recomputes.
    const channel = channelId ? safe(() => ChannelStoreRef?.getChannel?.(channelId)) : undefined;
    const poke = () => {
        if (channel) safe(() => FluxDispatcher.dispatch({ type: "CHANNEL_UPDATE", channel }));
        emit();
    };
    poke();
    // The list can be slow to pick the change up (especially while the action sheet is closing),
    // so keep nudging it for a few seconds.
    for (const delay of [150, 500, 1200, 2500]) setTimeout(poke, delay);
}

/** Removes a message from the local client only. Returns false if it's still in the store afterwards. */
function hideMessage(messageId: string, channelId: string): boolean {
    // Extra flags let the delete pass through message-logger style plugins that keep deleted messages
    const bypass = { mlDeleted: true, otherPluginBypass: true };
    const store = safe(() => findByStoreName("MessageStore"));
    const stillThere = () => !!safe(() => store?.getMessage?.(channelId, messageId));

    // Plugins like NoDelete+ hook FluxDispatcher.dispatch and rewrite deletes. Calling the
    // dispatcher's original (prototype) method skips every such hook.
    const rawDispatch = (action: any) => {
        const orig = safe(() => Object.getPrototypeOf(FluxDispatcher)?.dispatch);
        if (typeof orig !== "function") return false;
        orig.call(FluxDispatcher, action);
        return true;
    };
    const send = (action: any) => {
        if (!rawDispatch(action)) FluxDispatcher.dispatch(action);
    };

    send({ type: "MESSAGE_DELETE", id: messageId, channelId, ...bypass });
    if (stillThere()) {
        // Fall back to the normal (hookable) dispatch, then the bulk event
        FluxDispatcher.dispatch({ type: "MESSAGE_DELETE", id: messageId, channelId, ...bypass });
    }
    if (stillThere()) {
        send({ type: "MESSAGE_DELETE_BULK", ids: [messageId], channelId, ...bypass });
    }
    return !stillThere();
}

function toggleDm(channelId: string) {
    lastToggleAt = Date.now();
    readSinceToggle.clear();
    if (hiddenDmIds.has(channelId)) {
        hiddenDmIds.delete(channelId);
        if (!hiddenDmIds.size) showHiddenDms = false;
        showToast("DM unhidden");
    } else {
        hiddenDmIds.add(channelId);
        showToast("DM hidden until restart");
    }
    refreshDmList(channelId);
}

const idOf = (c: any): string | undefined => (typeof c === "string" ? c : c?.id ?? c?.channelId);

// Filtered results are cached per original result so the same object comes back while nothing
// changed (components that compare results by reference would otherwise re-render forever).
const filterCache = new WeakMap<object, { sig: string; value: any }>();
const lastToast: Record<string, number> = {};

// Debug timing: how long after a hide/unhide each DM-list getter is first read again
let lastToggleAt = 0;
const readSinceToggle = new Set<string>();

function filterList<T>(list: T, where = "?"): T {
    if (debugSheets && lastToggleAt && !readSinceToggle.has(where) && Date.now() - lastToggleAt < 15000) {
        readSinceToggle.add(where);
        showToast(`${where.split(".")[1] ?? where} re-read +${Date.now() - lastToggleAt}ms`);
    }

    if (showHiddenDms || !hiddenDmIds.size || !list || typeof list !== "object") return list;

    const sig = [...hiddenDmIds].join(",");
    const cached = filterCache.get(list as any);
    if (cached && cached.sig === sig) return cached.value;

    let value: any = list;
    let removed = 0;

    if (Array.isArray(list)) {
        const out = list.filter(c => !hiddenDmIds.has(idOf(c) as string));
        removed = list.length - out.length;
        if (removed) value = out;
    } else if (Object.getPrototypeOf(list) === Object.prototype) {
        // Map-like result keyed by channel id
        const keys = Object.keys(list as any);
        if (keys.some(k => hiddenDmIds.has(k))) {
            value = {};
            for (const k of keys) if (!hiddenDmIds.has(k)) value[k] = (list as any)[k];
            removed = keys.length - Object.keys(value).length;
        }
    }

    filterCache.set(list as any, { sig, value });

    if (removed && debugSheets && Date.now() - (lastToast[where] ?? 0) > 3000) {
        lastToast[where] = Date.now();
        showToast(`Filtered ${removed} DM via ${where}`);
    }
    return value;
}

/** Names of store getters that might feed the DM list. */
function dmListGetters(store: any): string[] {
    const names = new Set<string>();
    for (let o = store; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
        for (const n of Object.getOwnPropertyNames(o)) {
            if (
                n.startsWith("get") &&
                typeof store[n] === "function" &&
                /PrivateChannel|SortedChannels|DMChannel|PrivateChannelIds/.test(n) &&
                !/ById|ForUser|FromUser|Count|ForChannel/.test(n)
            ) {
                names.add(n);
            }
        }
    }
    return [...names];
}

const isDm = (channel: any) => channel && (channel.type === 1 || channel.type === 3);

const h = React.createElement;

/** Builds a row that looks like Discord's own (card + icon), falling back to a plain row. */
function makeRow(key: string, label: string, iconNames: string[], onPress: () => void) {
    const iconId = iconNames.map(n => safe(() => getAssetIDByName(n))).find(Boolean);

    if (TableMod?.TableRow) {
        const Icon = TableMod.TableRowIcon ?? TableMod.TableRow.Icon;
        const row = h(TableMod.TableRow, {
            key,
            label,
            onPress,
            icon: iconId && Icon ? h(Icon, { source: iconId }) : undefined,
        });
        return TableMod.TableRowGroup
            ? h(TableMod.TableRowGroup, { key: `${key}-group`, hasIcons: !!iconId }, row)
            : row;
    }

    return h(RowComponent, { key, label, onPress, icon: iconId });
}

const eyeIcons = ["ic_visibility", "ic_visibility_24px", "ic_eye", "ic_show_password"];

const typeName = (c: any) => String(c?.type?.name ?? c?.type?.displayName ?? "");
const isRowish = (c: any) =>
    !!c?.props && (typeof c.props.label === "string" || /Group|Row|Section/.test(typeName(c)));

/** Collects every array reachable through props.children. */
function collectArrays(node: any, out: any[][], seen: Set<any>, depth = 0) {
    if (!node || typeof node !== "object" || depth > 16 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
        out.push(node);
        for (const n of node) collectArrays(n, out, seen, depth + 1);
        return;
    }
    if (node.props) collectArrays(node.props.children, out, seen, depth + 1);
}

/** Inserts our row after the last real row/group of the sheet (before any trailing spacer). */
function insertIntoList(list: any[], row: any) {
    let at = -1;
    list.forEach((c, i) => {
        if (isRowish(c)) at = i;
    });
    list.splice(at === -1 ? list.length : at + 1, 0, row);
}

/**
 * Finds the list of rows/groups inside a rendered action sheet and inserts our row.
 * Returns false if no suitable list exists.
 */
function injectRow(res: any, row: any, strict = false): boolean {
    // 1. A list that directly contains rows (works for the message sheet)
    const direct = findInReactTree(
        res,
        (x: any) => Array.isArray(x) && x.length > 0 && x.some(isRowish)
    );
    if (direct) {
        insertIntoList(direct, row);
        return true;
    }
    if (strict) return false;

    // 2. Fallback: the largest list of React elements anywhere in the sheet
    const arrays: any[][] = [];
    collectArrays(res, arrays, new Set());
    let best: any[] | undefined;
    let bestScore = 1;
    for (const a of arrays) {
        const score = a.filter(c => c?.props && c?.type).length;
        if (score > bestScore) {
            best = a;
            bestScore = score;
        }
    }
    if (best) {
        insertIntoList(best, row);
        return true;
    }

    return false;
}

// Some sheets (e.g. the DM one) render their rows inside a nested component, so the rows
// aren't visible in the sheet's own element tree. For those we wrap the nested function
// components and inject into the first one whose output contains a list of rows.
interface ActivePatch {
    row: any;
    what: string;
    owner?: any;
}
let activePatch: ActivePatch | null = null;
const wrapperCache = new WeakMap<object, any>();
const SKIP_WRAP = /Table|Row|Group|Icon|Text|Pressable|Touchable|View|Image|Avatar|Button|Header/;

function wrapComponents(node: any, depth = 0, seen = new Set<any>()) {
    if (!node || typeof node !== "object" || depth > 12 || seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
        for (const n of node) wrapComponents(n, depth + 1, seen);
        return;
    }
    if (!node.props) return;

    const T = node.type;
    if (
        typeof T === "function" &&
        !T.prototype?.isReactComponent &&
        !SKIP_WRAP.test(String(T.displayName ?? T.name ?? ""))
    ) {
        let W = wrapperCache.get(T);
        if (!W) {
            W = function HideMessagesWrapped(props: any) {
                const out = T(props);
                const st = activePatch;
                if (st && (st.owner === undefined || st.owner === W) && injectRow(out, st.row, true)) {
                    if (st.owner === undefined && debugSheets) {
                        showToast(`HideMessages: injected into ${T.displayName ?? T.name ?? "component"}`);
                    }
                    st.owner = W;
                }
                return out;
            };
            W.displayName = T.displayName ?? T.name;
            wrapperCache.set(T, W);
        }
        try {
            node.type = W;
        } catch { /* frozen element: can't wrap this one */ }
    }

    wrapComponents(node.props.children, depth + 1, seen);
}

function patchSheet(component: Promise<any>, makeRow: () => any, what: string) {
    component.then((instance: any) => {
        const unpatch = after("default", instance, (_: any, res: any) => {
            React.useEffect(
                () => () => {
                    unpatch();
                    activePatch = null;
                },
                []
            );
            try {
                const row = makeRow();
                if (injectRow(res, row)) return res;

                // Rows live inside a nested component: hook into it instead
                activePatch = { row, what };
                wrapComponents(res);
            } catch (e: any) {
                showToast(`HideMessages: ${what} error: ${e?.message ?? e}`);
            }
            return res;
        });
    });
}

export const onLoad = () => {
    try {
        load();
        showToast("HideMessages loaded");
    } catch (e: any) {
        showToast(`HideMessages failed: ${e?.message ?? e}`);
    }
};

const load = () => {
    LazyActionSheet = safe(() => findByProps("openLazy", "hideActionSheet"));
    TableMod = safe(() => findByProps("TableRow", "TableRowGroup"));
    RowComponent =
        safe(() => findByProps("ActionSheetRow")?.ActionSheetRow) ??
        safe(() => findByName("ActionSheetRow", false)) ??
        safe(() => findByProps("TableRow")?.TableRow);
    PrivateChannelSortStore = safe(() => findByStoreName("PrivateChannelSortStore"));

    if (!LazyActionSheet) {
        showToast("HideMessages: action sheet module not found");
    } else if (!TableMod?.TableRow && !RowComponent) {
        showToast("HideMessages: row component not found");
    } else {
        unpatches.push(
            before("openLazy", LazyActionSheet, ([component, key, ctx]: any[]) => {
                if (debugSheets) {
                    showToast(`Sheet: ${key} {${Object.keys(ctx ?? {}).join(", ")}}`);
                }

                const message = ctx?.message;
                // The channel may be passed as an object, an id string, or only as an id field
                const rawChannel = ctx?.channel ?? ctx?.channelId ?? ctx?.privateChannel ?? ctx?.dm;
                const channelStore = safe(() => findByStoreName("ChannelStore"));
                const channel: any =
                    typeof rawChannel === "string"
                        ? safe(() => channelStore?.getChannel?.(rawChannel))
                        : rawChannel;

                // Message long-press sheet
                if (message && /Message/i.test(String(key))) {
                    patchSheet(
                        component,
                        () =>
                            makeRow("vc-hide-message", "Hide", eyeIcons, () => {
                                try {
                                    const channelId =
                                        message.channel_id ?? message.channelId ?? ctx?.channel?.id ?? ctx?.channelId;
                                    const ok = hideMessage(message.id, channelId);
                                    showToast(
                                        ok
                                            ? "Message hidden"
                                            : "Couldn't hide: message is still in Discord's store (a message logger plugin may be keeping it)"
                                    );
                                } catch (e: any) {
                                    showToast(`Hide failed: ${e?.message ?? e}`);
                                }
                                safe(() => LazyActionSheet.hideActionSheet());
                            }),
                        "Hide"
                    );
                    return;
                }

                // DM / group DM long-press sheet (any channel sheet whose channel is a DM)
                const dmChannel = channel && typeof channel === "object" ? channel : undefined;
                if (
                    dmChannel &&
                    isDm(dmChannel) &&
                    /Channel|DM|Private|Conversation|LongPress/i.test(String(key))
                ) {
                    patchSheet(
                        component,
                        () =>
                            makeRow(
                                "vc-hide-dm",
                                hiddenDmIds.has(dmChannel.id) ? "Unhide DM" : "Hide DM",
                                eyeIcons,
                                () => {
                                    toggleDm(dmChannel.id);
                                    safe(() => LazyActionSheet.hideActionSheet());
                                }
                            ),
                        "Hide DM"
                    );
                }
            })
        );
    }

    // Filter hidden DMs out of the DM list
    ChannelStoreRef = safe(() => findByStoreName("ChannelStore"));
    const patched: string[] = [];
    for (const [storeName, store] of [
        ["PrivateChannelSortStore", PrivateChannelSortStore],
        ["ChannelStore", ChannelStoreRef],
    ] as [string, any][]) {
        if (!store) continue;
        const methods = new Set([
            ...dmListGetters(store),
            ...(storeName === "PrivateChannelSortStore" ? ["getSortedChannels", "getPrivateChannelIds"] : []),
        ]);
        for (const method of methods) {
            if (typeof store[method] !== "function") continue;
            const where = `${storeName}.${method}`;
            patched.push(where);
            unpatches.push(
                safe(() => after(method, store, (_: any, res: any) => filterList(res, where))) ?? (() => {})
            );
        }
    }
    patchedGetters = patched;

    // Slash commands (fallback that doesn't depend on Discord's sheet internals)
    const base = { applicationId: "-1", inputType: 1, type: 1, options: [] as any[] };
    const cmd = (name: string, description: string, execute: (args: any, ctx: any) => void) =>
        registerCommand({
            ...base,
            name,
            displayName: name,
            description,
            displayDescription: description,
            execute,
        });

    unpatches.push(
        cmd("hidedm", "Hide/unhide this DM until you restart", (_a, ctx) => {
            const channel = ctx?.channel;
            if (!channel || !isDm(channel)) {
                showToast("This isn't a DM");
                return;
            }
            toggleDm(channel.id);
        }),
        cmd("showhiddendms", "Toggle showing hidden DMs in the DM list", () => {
            if (!hiddenDmIds.size) {
                showToast("No hidden DMs");
                return;
            }
            showHiddenDms = !showHiddenDms;
            showToast(showHiddenDms ? "Showing hidden DMs" : "Hiding hidden DMs");
            refreshDmList();
        }),
        cmd("hidedebug", "HideMessages: show the name of every action sheet you open", () => {
            debugSheets = !debugSheets;
            showToast(debugSheets ? "Sheet debug ON" : "Sheet debug OFF");
            if (debugSheets) {
                showToast(`DM list getters patched: ${patchedGetters.join(", ") || "none found"}`);
            }
        })
    );
};

export const onUnload = () => {
    for (const unpatch of unpatches) unpatch();
    unpatches.length = 0;
    hiddenDmIds.clear();
    showHiddenDms = false;
    debugSheets = false;
    refreshDmList();
};
