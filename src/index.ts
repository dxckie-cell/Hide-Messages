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

function refreshDmList() {
    try {
        PrivateChannelSortStore?.emitChange?.();
    } catch { /* ignore */ }
}

/** Removes a message from the local client only. Returns false if it's still in the store afterwards. */
function hideMessage(messageId: string, channelId: string): boolean {
    // Extra flags let the delete pass through message-logger style plugins that keep deleted messages
    const bypass = { mlDeleted: true, otherPluginBypass: true };
    const store = safe(() => findByStoreName("MessageStore"));
    const stillThere = () => !!safe(() => store?.getMessage?.(channelId, messageId));

    FluxDispatcher.dispatch({ type: "MESSAGE_DELETE", id: messageId, channelId, ...bypass });
    if (stillThere()) {
        FluxDispatcher.dispatch({ type: "MESSAGE_DELETE_BULK", ids: [messageId], channelId, ...bypass });
    }
    return !stillThere();
}

function toggleDm(channelId: string) {
    if (hiddenDmIds.has(channelId)) {
        hiddenDmIds.delete(channelId);
        if (!hiddenDmIds.size) showHiddenDms = false;
        showToast("DM unhidden");
    } else {
        hiddenDmIds.add(channelId);
        showToast("DM hidden until restart");
    }
    refreshDmList();
}

const idOf = (c: any): string | undefined => (typeof c === "string" ? c : c?.id ?? c?.channelId);

function filterList<T>(list: T): T {
    if (showHiddenDms || !hiddenDmIds.size || !Array.isArray(list)) return list;
    return list.filter(c => !hiddenDmIds.has(idOf(c) as string)) as unknown as T;
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

/** Finds the array of rows/buttons inside a rendered action sheet and inserts our row. */
function injectRow(res: any, row: any): boolean {
    const list = findInReactTree(
        res,
        (x: any) =>
            Array.isArray(x) &&
            x.length > 0 &&
            x.some(
                (c: any) =>
                    c?.props &&
                    (typeof c.props.label === "string" ||
                        /Row/.test(String(c.type?.name ?? c.type?.displayName ?? "")))
            )
    );
    if (!list) return false;
    list.splice(Math.min(1, list.length), 0, row);
    return true;
}

function patchSheet(component: Promise<any>, makeRow: () => any, what: string) {
    component.then((instance: any) => {
        const unpatch = after("default", instance, (_: any, res: any) => {
            React.useEffect(() => () => void unpatch(), []);
            try {
                if (!injectRow(res, makeRow())) showToast(`HideMessages: couldn't add ${what} button`);
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
                if (debugSheets) showToast(`Sheet: ${key}`);

                const message = ctx?.message;
                const channel = ctx?.channel ?? ctx?.channelId;

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
                const dmChannel =
                    typeof channel === "object" ? channel : undefined;
                if (dmChannel && isDm(dmChannel) && /Channel|DM|Private/i.test(String(key))) {
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
    if (PrivateChannelSortStore) {
        for (const method of ["getSortedChannels", "getPrivateChannelIds"]) {
            if (typeof PrivateChannelSortStore[method] === "function") {
                unpatches.push(
                    after(method, PrivateChannelSortStore, (_: any, res: any) => filterList(res))
                );
            }
        }
    }

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
