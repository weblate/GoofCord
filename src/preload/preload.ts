import "./bridge";

import {ipcRenderer} from "electron";
import * as fs from "fs";
import * as path from "path";
import {addScript, addStyle, sleep} from "../utils";
import {fixTitlebar, injectTitlebar} from "./titlebar";

window.localStorage.setItem("hideNag", "true");

const version = ipcRenderer.sendSync("displayVersion");

console.log("GoofCord " + version);
ipcRenderer.on("themeLoader", (event, message) => {
    addStyle(message);
});
if (ipcRenderer.sendSync("titlebar")) {
    injectTitlebar();
}
sleep(5000).then(async () => {
    // dirty hack to make clicking notifications focus GoofCord
    addScript(`
    (() => {
    const originalSetter = Object.getOwnPropertyDescriptor(Notification.prototype, "onclick").set;
    Object.defineProperty(Notification.prototype, "onclick", {
        set(onClick) {
        originalSetter.call(this, function() {
            onClick.apply(this, arguments);
            goofcord.window.show();
            goofcord.window.maximize();
        })
        },
        configurable: true
    });
    })();
    `);
    const cssPath = path.join(__dirname, "../", "/content/css/discord.css");
    addStyle(fs.readFileSync(cssPath, "utf8"));
    if (document.getElementById("window-controls-container") == null) {
        console.warn("Titlebar didn't inject, retrying...");
        if (ipcRenderer.sendSync("titlebar")) {
            fixTitlebar();
        }
    }
});

// Settings info version injection
setInterval(() => {
    const host = document.querySelector("nav > [class|=side] [class|=info]");
    if (!host || host.querySelector("#ac-ver")) return;
    const el = host.firstChild!.cloneNode() as HTMLSpanElement;
    el.id = "ac-ver";

    el.textContent = `GoofCord Version: ${version} ⚙️`;
    el.onclick = () => ipcRenderer.send("openSettingsWindow");
    host.append(el);
}, 2000);
