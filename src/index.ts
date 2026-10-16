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

const unpatches: (() => void)[] = [];

const safe = <T,>(fn: () => T): T | undefined => {
    try {
        return fn();
    } catch {
        return undefined;
    }
};

const h = React.createElement;
const eyeIcons = ["ic_visibility", "ic_visibility_24px", "ic_eye", "ic_show_password"];

/** Removes a message from the local client only. Returns false if it's still in the store afterwards. */
function hideMessage(messageId: string, channelId: string): boolean {
    // Extra flags let the delete pass through message-logger style plugins that keep deleted messages
    const bypass = { mlDeleted: true, otherPluginBypass: true };
    const store = safe(() => findByStoreName("MessageStore"));
    const stillThere = () => !!safe(() => store?.getMessage?.(channelId, messageId));

    // Plugins like NoDelete+ hook FluxDispatcher.dispatch and rewrite deletes. Calling the
    // dispatcher's original (prototype) method skips every such hook.
    const send = (action: any) => {
        const orig = safe(() => Object.getPrototypeOf(FluxDispatcher)?.dispatch);
        if (typeof orig === "function") orig.call(FluxDispatcher, action);
        else FluxDispatcher.dispatch(action);
    };

    send({ type: "MESSAGE_DELETE", id: messageId, channelId, ...bypass });
    if (stillThere()) FluxDispatcher.dispatch({ type: "MESSAGE_DELETE", id: messageId, channelId, ...bypass });
    if (stillThere()) send({ type: "MESSAGE_DELETE_BULK", ids: [messageId], channelId, ...bypass });
    return !stillThere();
}

/** Builds a row that looks like Discord's own (card + icon), falling back to a plain row. */
function makeRow(key: string, label: string, onPress: () => void) {
    const iconId = eyeIcons.map(n => safe(() => getAssetIDByName(n))).find(Boolean);

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

const typeName = (c: any) => String(c?.type?.name ?? c?.type?.displayName ?? "");
const isRowish = (c: any) =>
    !!c?.props && (typeof c.props.label === "string" || /Group|Row|Section/.test(typeName(c)));

/** True if a row/group actually has something inside (an empty group still takes up space). */
const hasContent = (c: any) => {
    const kids = c?.props?.children;
    if (kids === undefined) return typeof c?.props?.label === "string";
    return [kids].flat(Infinity).some((k: any) => k !== null && k !== undefined && k !== false && k !== "");
};

/** Inserts our row after the last real row/group of the sheet (before any trailing spacer). */
function injectRow(res: any, row: any): boolean {
    const list = findInReactTree(res, (x: any) => Array.isArray(x) && x.length > 0 && x.some(isRowish));
    if (!list) return false;
    let at = -1;
    list.forEach((c: any, i: number) => {
        if (isRowish(c) && hasContent(c)) at = i;
    });
    if (at === -1) list.forEach((c: any, i: number) => (isRowish(c) ? (at = i) : 0));
    list.splice(at + 1, 0, row);
    return true;
}

function patchSheet(component: Promise<any>, makeIt: () => any) {
    component.then((instance: any) => {
        const unpatch = after("default", instance, (_: any, res: any) => {
            React.useEffect(() => () => unpatch(), []);
            try {
                injectRow(res, makeIt());
            } catch (e: any) {
                showToast(`HideMessages: ${e?.message ?? e}`);
            }
            return res;
        });
    });
}

export const onLoad = () => {
    try {
        LazyActionSheet = safe(() => findByProps("openLazy", "hideActionSheet"));
        TableMod = safe(() => findByProps("TableRow", "TableRowGroup"));
        RowComponent =
            safe(() => findByProps("ActionSheetRow")?.ActionSheetRow) ??
            safe(() => findByName("ActionSheetRow", false)) ??
            safe(() => findByProps("TableRow")?.TableRow);

        if (!LazyActionSheet || (!TableMod?.TableRow && !RowComponent)) {
            showToast("HideMessages: couldn't find Discord's action sheet");
            return;
        }

        unpatches.push(
            before("openLazy", LazyActionSheet, ([component, key, ctx]: any[]) => {
                const message = ctx?.message;
                if (!message || !/Message/i.test(String(key))) return;

                patchSheet(component, () =>
                    makeRow("vc-hide-message", "Hide", () => {
                        try {
                            const channelId =
                                message.channel_id ?? message.channelId ?? ctx?.channel?.id ?? ctx?.channelId;
                            showToast(
                                hideMessage(message.id, channelId)
                                    ? "Message hidden"
                                    : "Couldn't hide: a message logger plugin may be keeping it"
                            );
                        } catch (e: any) {
                            showToast(`Hide failed: ${e?.message ?? e}`);
                        }
                        safe(() => LazyActionSheet.hideActionSheet());
                    })
                );
            })
        );
    } catch (e: any) {
        showToast(`HideMessages failed: ${e?.message ?? e}`);
    }
};

export const onUnload = () => {
    for (const unpatch of unpatches) unpatch();
    unpatches.length = 0;
};
