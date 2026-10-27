/**
 * DevTools page. Runs in the DevTools extension context, whose only job is to
 * register the panel and report the inspected tab id to it.
 */

chrome.devtools.panels.create(
  "Proto Inspector",
  "",
  "panel/panel.html",
  (panel) => {
    panel.onShown.addListener((panelWindow) => {
      const w = panelWindow as unknown as Window & { protoInspectorTabId?: number };
      w.protoInspectorTabId = chrome.devtools.inspectedWindow.tabId;
      w.dispatchEvent(new CustomEvent("proto-inspector:tab-id", {
        detail: chrome.devtools.inspectedWindow.tabId,
      }));
    });
  },
);
