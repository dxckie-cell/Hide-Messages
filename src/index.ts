import { registerCommand } from "@vendetta/commands";
import { findByName, findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher, React } from "@vendetta/metro/common";
import { after, before } from "@vendetta/patcher";
import { showToast } from "@vendetta/ui/toasts";
import { findInReactTree } from "@vendetta/utils";

const LazyActionSheet = findByProps("openLazy", "hideActionSheet");
const ActionSheetRow =
    findByProps("ActionSheetRow")?.ActionSheetRow ?? findByName("ActionSheetRow");
const PrivateChannelSortStore = findByStoreName("PrivateChannelSortStore");

// In-memory only: everything resets when Discord restarts (or the plugin is unloaded)
const hiddenDmIds = new Set<string>();
let showHiddenDms = false;

const unpatches: (() => void)[] = [];

function refreshDmList() {
    try {
        PrivateChannelSortStore?.emitChange?.();
    } catch { /* ignore */ }
}

function hideMessage(messageId: string, channelId: string) {
    FluxDispatcher.dispatch({
        type: "MESSAGE_DELETE",
        id: messageId,
        channelId,
        mlDeleted: true,
    });
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

export const onLoad = () => {
    // 1. "Hide" button in the message long-press sheet
    if (LazyActionSheet && ActionSheetRow) {
        unpatches.push(
            before("openLazy", LazyActionSheet, ([component, key, ctx]: any[]) => {
                if (key !== "MessageLongPressActionSheet") return;
                const message = ctx?.message;
                if (!message) return;

                component.then((instance: any) => {
                    const unpatch = after("default", instance, (_: any, res: any) => {
                        React.useEffect(() => () => void unpatch(), []);

                        const buttons = findInReactTree(
                            res,
                            (x: any) => x?.[0]?.type?.name === "ButtonRow"
                        );
                        if (!buttons) return;

                        buttons.splice(
                            1,
                            0,
                            React.createElement(ActionSheetRow, {
                                label: "Hide",
                                onPress: () => {
                                    hideMessage(message.id, message.channel_id);
                                    LazyActionSheet.hideActionSheet();
                                },
                            })
                        );
                    });
                });
            })
        );
    }

    // 2. Filter hidden DMs out of the DM list
    if (PrivateChannelSortStore) {
        for (const method of ["getSortedChannels", "getPrivateChannelIds"]) {
            if (typeof PrivateChannelSortStore[method] === "function") {
                unpatches.push(
                    after(method, PrivateChannelSortStore, (_: any, res: any) => filterList(res))
                );
            }
        }
    }

    // 3. Slash commands (mobile has no DM context-menu entry to patch reliably)
    const base = { applicationId: "-1", inputType: 1, type: 1, options: [] as any[] };

    unpatches.push(
        registerCommand({
            ...base,
            name: "hidedm",
            displayName: "hidedm",
            description: "Hide/unhide this DM until you restart",
            displayDescription: "Hide/unhide this DM until you restart",
            execute: (_args: any, ctx: any) => {
                const channel = ctx?.channel;
                if (!channel) return;
                // 1 = DM, 3 = group DM
                if (channel.type !== 1 && channel.type !== 3) {
                    showToast("This isn't a DM");
                    return;
                }
                toggleDm(channel.id);
            },
        }),
        registerCommand({
            ...base,
            name: "showhiddendms",
            displayName: "showhiddendms",
            description: "Toggle showing hidden DMs in the DM list",
            displayDescription: "Toggle showing hidden DMs in the DM list",
            execute: () => {
                if (!hiddenDmIds.size) {
                    showToast("No hidden DMs");
                    return;
                }
                showHiddenDms = !showHiddenDms;
                showToast(showHiddenDms ? "Showing hidden DMs" : "Hiding hidden DMs");
                refreshDmList();
            },
        })
    );
};

export const onUnload = () => {
    for (const unpatch of unpatches) unpatch();
    unpatches.length = 0;
    hiddenDmIds.clear();
    showHiddenDms = false;
    refreshDmList();
};
