import fs from "fs";
import {app, dialog, session} from "electron";
import {fetchWithTimeout, tryWithFix} from "../utils";
import {patchVencord} from "../scriptLoader/vencordPatcher";
import path from "path";
import {getConfig} from "../config/config";
import extract from "extract-zip";

const modName: keyof typeof MOD_BUNDLE_URLS = getConfig("modName");

export async function loadExtensions() {
    const userDataPath = app.getPath("userData");
    const extensionsFolder = path.join(userDataPath, "extensions/");
    try {
        for (const file of (await fs.promises.readdir(extensionsFolder))) {
            session.defaultSession.loadExtension(`${userDataPath}/extensions/${file}`);
            console.log(`[Mod loader] Loaded extension: ${file}`);
        }
    } catch (e: any) {
        if (e.code === "ENOENT") {
            installModLoader();
        }
        console.error("[Mod loader] Failed to load extensions:", e);
    }
}

const MOD_BUNDLE_URLS = {
    none: "https://github.com/Vendicated/Vencord/releases/download/devbuild/browser.js",
    vencord: "https://github.com/Vendicated/Vencord/releases/download/devbuild/browser.js",
    shelter: "https://raw.githubusercontent.com/uwu/shelter-builds/main/shelter.js",
    custom: getConfig("customJsBundle"), // Initialize with an empty string and populate it later
};

const MOD_BUNDLE_CSS_URLS = {
    none: "https://github.com/Vendicated/Vencord/releases/download/devbuild/browser.css",
    vencord: "https://github.com/Vendicated/Vencord/releases/download/devbuild/browser.css",
    shelter: "https://raw.githubusercontent.com/Milkshiift/empty/main/empty.txt",
    custom: getConfig("customCssBundle"), // Initialize with an empty string and populate it later
};

const EXTENSION_DOWNLOAD_TIMEOUT = 10000;

async function downloadAndWriteBundle(url: string, filePath: string) {
    try {
        const response = await fetchWithTimeout(url, {method: "GET"}, EXTENSION_DOWNLOAD_TIMEOUT);

        let bundle = await response.text();

        if (!url.endsWith(".css") && containsVencord(bundle)) {
            bundle = await patchVencord(bundle);
        }

        await tryWithFix(() => {
            fs.promises.writeFile(filePath, bundle, "utf-8");
        }, installModLoader, "[Mod loader] Failed to write bundle:");
    } catch (e: any) {
        console.error("[Mod loader] Failed to download bundle:", e);
        dialog.showErrorBox("GoofCord was unable to download the mod bundle", e.toString());
        throw e;
    }
}

function containsVencord(str: string) {
    // Get the first 150 characters of the string
    const substring = str.slice(0, 150);
    // Check if "Vencord" is present in the substring
    return substring.indexOf("Vencord") !== -1;
}

export async function updateModBundle() {
    if (getConfig("noBundleUpdates") || modName === "none") {
        console.log("[Mod loader] Skipping mod bundle update");
        return;
    }

    const distFolder = path.join(app.getPath("userData"), "extensions/loader/dist/");

    console.log("[Mod loader] Downloading mod bundle");

    await downloadAndWriteBundle(MOD_BUNDLE_URLS[modName], path.join(distFolder, "bundle.js"));
    await downloadAndWriteBundle(MOD_BUNDLE_CSS_URLS[modName], path.join(distFolder, "bundle.css"));

    console.log("[Mod loader] Mod bundle updated");
}

async function installModLoader() {
    const extensionFolder = path.join(app.getPath("userData"), "extensions/");
    try {
        await fs.promises.mkdir(extensionFolder);
    } catch (e) {}

    try {
        const zipBuffer = await fs.promises.readFile(path.join(__dirname, "assets/js/loader.zip"));
        await extract.extractBuffer(zipBuffer, {dir: extensionFolder});

        console.log("[Mod loader] Mod loader installed");
    } catch (error) {
        console.error("[Mod loader] Failed to install the mod loader");
        console.error(error);
        dialog.showErrorBox(
            "Oops, something went wrong.",
            `GoofCord couldn't install the internal mod loader.\n\n${error}`
        );
    }
}