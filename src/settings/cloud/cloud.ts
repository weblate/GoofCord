import chalk from "chalk";
import { dialog, safeStorage } from "electron";
import { cachedConfig, getConfig, setConfigBulk } from "../../config";
import { encryptionPasswords } from "../../modules/messageEncryption";
import { decryptString, encryptString } from "./encryption";
import { deleteToken, getCloudHost, getCloudToken } from "./token";

export const LOG_PREFIX = chalk.cyanBright("[Cloud Settings]");

function getEncryptionKey(): string {
	try {
		return safeStorage.decryptString(Buffer.from(getConfig("cloudEncryptionKey"), "base64"));
	} catch (e) {
		return "";
	}
}

export async function loadCloud() {
	const response = await callEndpoint("load", "GET");
	if (!response?.settings || response.settings.length < 50) {
		await showDialogAndLog("info", "Cloud Settings", "Nothing to load");
		return;
	}

	const cloudSettings = await decryptString(response.settings, getEncryptionKey());
	if (!cloudSettings) return;
	console.log(LOG_PREFIX, "Loading cloud settings:", cloudSettings);

	const configToSet = { ...cachedConfig };
	for (const [key, value] of Object.entries(cloudSettings)) {
		configToSet[key] = value;
	}
	await setConfigBulk(configToSet);
	await showDialogAndLog("info", "Settings loaded", "Settings loaded from cloud successfully. Please restart GoofCord to apply the changes.");
}

export async function saveCloud() {
	const excludedOptions = ["cloudEncryptionKey", "cloudHost", "cloudToken"];
	const configToSave = { ...cachedConfig };
	if (getEncryptionKey()) {
		// biome-ignore lint/complexity/useLiteralKeys: Config currently does not have types
		configToSave["encryptionPasswords"] = encryptionPasswords;
	} else {
		excludedOptions.push("encryptionPasswords");
	}

	const settings = Object.fromEntries(Object.entries(configToSave).filter(([key]) => !excludedOptions.includes(key)));
	const encryptedSettings = await encryptString(JSON.stringify(settings), getEncryptionKey());
	if (!encryptedSettings) return;

	const response = await callEndpoint("save", "POST", JSON.stringify({ settings: encryptedSettings }));
	if (!response) return;
	await showDialogAndLog("info", "Settings saved", "Settings saved successfully on cloud.");
}

export async function deleteCloud() {
	const response = await callEndpoint("delete", "GET");
	if (!response) return;
	await deleteToken();
	await showDialogAndLog("info", "Settings deleted", "Settings deleted from cloud successfully.");
}

async function callEndpoint(endpoint: string, method: string, body?: string) {
	try {
		console.log(LOG_PREFIX, "Calling endpoint:", endpoint);
		const response = await fetch(getCloudHost() + endpoint, {
			method,
			headers: {
				"Content-Type": "application/json",
				Authorization: await getCloudToken(),
			},
			body,
		});

		console.log(LOG_PREFIX, "Received server response:", await response.clone().text());
		const responseJson = await response.json();
		if (responseJson.error) throw new Error(responseJson.error);
		return responseJson;
	} catch (error: unknown) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		if (errorMessage.includes("Unauthorized")) await deleteToken();
		await showDialogAndLog("error", "Cloud error", `Error when calling "${endpoint}" endpoint: ${errorMessage}`);
		return undefined;
	}
}

export async function showDialogAndLog(type: "info" | "error", title: string, message: string) {
	type === "info" ? console.log(LOG_PREFIX, message) : console.error(LOG_PREFIX, message);
	await dialog.showMessageBox({
		type,
		title,
		message,
		buttons: ["OK"],
	});
}
