import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { app, dialog, safeStorage, shell } from "electron";
import { createHost, type StoreHost } from "electron-sync-store/main";
import pc from "picocolors";

import { type Config, type ConfigKey, getDefaults, isEncrypted } from "../../settingsSchema.ts";
import { getErrorMessage, getGoofCordFolderPath, tryCreateFolder } from "../../utils.ts";

const LOG_PREFIX = pc.yellowBright("[Config]");

// ─── State & Initialization ─────────────────────────────────────────────

export let firstLaunch = false;
let configHost: StoreHost<Config>;
let _encryptionAvailable: boolean | undefined = undefined;
type PendingEncryption = { value: unknown; fallback?: unknown };
const pendingEncryption = new Map<ConfigKey, PendingEncryption>();
let needsReEncryption = false;

function getStorageBackend(): string {
	return process.platform === "linux" ? safeStorage.getSelectedStorageBackend() : "unknown";
}

export async function initConfigEncryption(): Promise<boolean> {
	if (_encryptionAvailable !== undefined) return _encryptionAvailable;

	await app.whenReady();

	_encryptionAvailable = await safeStorage.isAsyncEncryptionAvailable();

	if (!_encryptionAvailable && firstLaunch) {
		await dialog.showMessageBox({
			type: "warning",
			title: "Secure storage unavailable",
			message: "Some sensitive settings (e.g. message encryption passwords) will be stored in plaintext.\n" + (process.platform === "linux" ? "Install and start gnome-keyring or kwallet, then restart the app." : "This is unusual on Windows/macOS — please report the issue."),
			detail: `Backend: ${getStorageBackend() || "unknown"}`,
		});
	}

	if (_encryptionAvailable && process.platform === "linux") {
		console.log(LOG_PREFIX, `Secure backend: ${getStorageBackend()}`);
	} else if (!_encryptionAvailable) {
		console.warn(LOG_PREFIX, "safeStorage encryption unavailable — using plaintext fallback");
	}

	return _encryptionAvailable;
}

export async function loadConfig(): Promise<void> {
	configHost = createHost<Config>("config", {
		onHydrate: hydrate,
		onPersist: saveToDisk,
	});
	await configHost.ready();
}

async function setup(): Promise<Config> {
	console.log(LOG_PREFIX, "Setting up default GoofCord settings.");
	firstLaunch = true;
	pendingEncryption.clear();
	const defaults = getDefaults();
	await saveToDisk(defaults);
	return defaults;
}

// ─── Getters ─────────────────────────────────────────────

export function getConfig<K extends ConfigKey>(key: K): Config[K] {
	return configHost.get()[key] ?? getDefaultValue(key);
}

export function getConfigRaw<K extends ConfigKey>(key: K): Config[K] | undefined {
	return configHost.get()[key];
}

export function getConfigBulk(): Config {
	return configHost.get();
}

export function getDefaultValue<K extends ConfigKey>(entry: K): Config[K] {
	return getDefaults()[entry] as Config[K];
}

// ─── Setters ─────────────────────────────────────────────

export async function setConfig<K extends ConfigKey>(key: K, value: Config[K]): Promise<void> {
	const current = configHost.get();
	await configHost.set({ ...current, [key]: value });
}

export async function setConfigBulk(config: Config): Promise<void> {
	await configHost.set(config);
}

// ─── Maintenance ─────────────────────────────────────────────

export async function cleanUpConfig(): Promise<void> {
	const currentConfig = configHost.get();
	const defaults = getDefaults();
	const validKeys = new Set(Object.keys(defaults));

	const cleanedConfig = { ...currentConfig };
	let hasChanges = false;
	let removedCount = 0;

	for (const key of Object.keys(cleanedConfig)) {
		if (!validKeys.has(key)) {
			// @ts-expect-error: Deleting a key that isn't in the type definition
			delete cleanedConfig[key];
			hasChanges = true;
			removedCount++;
			console.log(LOG_PREFIX, `Removed obsolete property: "${key}"`);
		}
	}

	if (hasChanges) {
		console.log(LOG_PREFIX, `Cleanup complete. Removed ${removedCount} obsolete keys.`);
		await configHost.set(cleanedConfig);
	}
}

// ─── Private ─────────────────────────────────────────────

async function hydrate(): Promise<Config> {
	while (true) {
		try {
			// fs.promises.readFile is much slower than fs.readFileSync
			const rawData = fs.readFileSync(getConfigLocation(), "utf-8");
			const config = JSON.parse(rawData) as Config;
			pendingEncryption.clear();
			for (const [key, value] of Object.entries(config)) {
				if (isEncrypted(key)) pendingEncryption.set(key as ConfigKey, { value });
			}
			return config;
		} catch (e: unknown) {
			const result = await handleConfigError(e);
			if (result.data) return result.data;
			if (!result.retry) {
				pendingEncryption.clear();
				return getDefaults();
			}
		}
	}
}

async function saveToDisk(state: Config) {
	// Safeguard for safeStorage.
	// This should only trigger on setup, where we don't mind the extra delay.
	await app.whenReady();

	try {
		for (const [key, value] of Object.entries(state)) {
			if (!isEncrypted(key)) continue;

			const typedKey = key as ConfigKey;
			const pending = pendingEncryption.get(typedKey);
			if (pending && value === pending.value) continue;

			if (pending?.fallback !== undefined && isDeepStrictEqual(value, pending.fallback)) {
				(state as any)[typedKey] = pending.value;
				continue;
			}

			pendingEncryption.delete(typedKey);
			(state as any)[typedKey] = await encryptSafeStorage(value);
		}
		const configPath = getConfigLocation();
		const tempPath = `${configPath}.tmp`;
		await fs.promises.writeFile(tempPath, JSON.stringify(state, null, 2), "utf-8");
		await fs.promises.rename(tempPath, configPath);
	} catch (e: unknown) {
		console.error(LOG_PREFIX, "Failed to save settings:", e);
		dialog.showErrorBox("GoofCord was unable to save the settings", getErrorMessage(e));
	}
}

export async function decryptSettings() {
	// Safeguard for safeStorage. Ideally the function should be called after init.
	await app.whenReady();

	needsReEncryption = false;
	const config = configHost.get();
	let decryptionFailed = false;

	for (const [key, value] of Object.entries(config)) {
		if (!isEncrypted(key)) continue;

		const typedKey = key as ConfigKey;
		const pending = pendingEncryption.get(typedKey);
		const encryptedValue = pending?.fallback !== undefined && isDeepStrictEqual(value, pending.fallback) ? pending.value : value;

		try {
			if (typeof encryptedValue !== "string") {
				pendingEncryption.delete(typedKey);
				continue;
			}

			(config as any)[typedKey] = await decryptSafeStorage(encryptedValue);
			pendingEncryption.delete(typedKey);
		} catch (e) {
			decryptionFailed = true;
			const message = getErrorMessage(e);
			const temporarilyUnavailable = _encryptionAvailable === false || message.includes("temporarily unavailable");

			if (temporarilyUnavailable) {
				console.warn(LOG_PREFIX, `Keeping encrypted setting "${key}" unchanged because secure storage is unavailable: ${message}`);
				pendingEncryption.set(typedKey, { value: encryptedValue, fallback: getDefaultValue(typedKey) });
				(config as any)[typedKey] = getDefaultValue(typedKey);
			} else {
				console.error(LOG_PREFIX, `Failed to decrypt setting "${key}":`, e);
				(config as any)[typedKey] = getDefaultValue(typedKey);
				pendingEncryption.delete(typedKey);
			}
		}
	}

	if (needsReEncryption && !decryptionFailed) {
		await configHost.set(config);
	} else {
		await configHost.set(config, { persist: false });
	}

	if (pendingEncryption.size > 0) {
		await dialog.showMessageBox({
			type: "warning",
			title: "Some settings could not be decrypted",
			message: "Secure storage is unavailable, so some encrypted settings could not be read. They have been left unchanged on disk and will be restored when secure storage is available again.",
			detail: "Restart the app after unlocking your keyring. Changing these settings now will overwrite the saved encrypted values.",
		});
	}
}

export async function encryptSafeStorage(plaintext: unknown): Promise<string> {
	const json = JSON.stringify(plaintext);

	if (!_encryptionAvailable && _encryptionAvailable !== undefined) {
		return `PLAIN:${json}`;
	}

	try {
		const buf = await safeStorage.encryptStringAsync(json);
		return `ENC:${buf.toString("base64")}`;
	} catch (err) {
		console.error(LOG_PREFIX, "encryptSafeStorage failed:", err);
		_encryptionAvailable = false;
		return `PLAIN:${json}`;
	}
}

export async function decryptSafeStorage(stored: string): Promise<any> {
	if (stored.startsWith("PLAIN:")) {
		return JSON.parse(stored.slice(6));
	}

	if (stored.startsWith("ENC:")) {
		const base64 = stored.slice(4);
		try {
			const buf = Buffer.from(base64, "base64");
			let decrypted = await safeStorage.decryptStringAsync(buf);
			if (decrypted.shouldReEncrypt) {
				needsReEncryption = true;
				decrypted = await safeStorage.decryptStringAsync(buf);
			}
			return JSON.parse(decrypted.result);
		} catch (err) {
			console.error(LOG_PREFIX, "decryptSafeStorage failed:", err);
			throw new Error(`Cannot decrypt protected setting: ${getErrorMessage(err)}`);
		}
	}

	throw new Error(`Unknown storage prefix: ${stored.slice(0, 10)}…`);
}

async function handleConfigError(e: unknown): Promise<{ retry: boolean; data?: Config }> {
	if (e instanceof Error && "code" in e && e.code === "ENOENT") {
		tryCreateFolder(getGoofCordFolderPath());
		return { retry: false, data: await setup() };
	}

	console.error(LOG_PREFIX, "Failed to load the config:", e);
	await app.whenReady();

	const buttonId = dialog.showMessageBoxSync({
		type: "question",
		buttons: ["Try again", "Open config folder", "Reset config", "Exit"],
		defaultId: 0,
		title: "Failed to load configuration",
		message: `Config loader errored:\n${getErrorMessage(e)}`,
	});

	switch (buttonId) {
		case 1: // Open folder
			void shell.openPath(getGoofCordFolderPath());
			return { retry: true };
		case 2: // Reset
			return { retry: false, data: await setup() };
		case 3: // Exit
			app.exit();
			throw new Error("Application exiting");
		default:
			return { retry: true };
	}
}

function getConfigLocation(): string {
	return path.join(getGoofCordFolderPath(), "settings.json");
}
