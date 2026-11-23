// This file contains everything that uses session.defaultSession.webRequest
import { session } from "electron";
import pc from "picocolors";

import type { Config, ConfigKey } from "../settingsSchema.ts";
import { getConfig, getDefaultValue } from "../stores/config/config.main.ts";

function getConfigOrDefault<K extends ConfigKey>(toGet: K): Config[K] {
	return getConfig("customFirewallRules") ? getConfig(toGet) : getDefaultValue(toGet);
}

function compileRegex(strings: string[]): RegExp | null {
	if (!Array.isArray(strings)) return null;
	const patterns = strings.filter(Boolean);
	if (patterns.length === 0) return null;

	try {
		return new RegExp(patterns.join("|"), "i");
	} catch (e) {
		console.error(pc.red("[Firewall]"), "Invalid firewall regex:", e);
		return null;
	}
}

export function initFirewall() {
	if (!getConfig("firewall")) return;
	const blocklist = getConfigOrDefault("blocklist");
	const blockedStrings = getConfigOrDefault("blockedStrings");
	const allowedStrings = getConfigOrDefault("allowedStrings");

	// If blocklist is not empty
	const blocklistPatterns = Array.isArray(blocklist) ? blocklist.filter(Boolean) : [];
	if (blocklistPatterns.length > 0) {
		// Blocking URLs. This list works in tandem with "blockedStrings" list.
		session.defaultSession.webRequest.onBeforeRequest(
			{
				urls: blocklistPatterns,
			},
			(_, callback) => callback({ cancel: true }),
		);
	}

	/* If the request url includes any of those, it is blocked.
	 * By doing so, we can match multiple unwanted URLs, making the blocklist cleaner and more efficient */
	const blockRegex = compileRegex(blockedStrings);
	const allowRegex = compileRegex(allowedStrings);

	session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ["<all_urls>"] }, (details, callback) => {
		// No need to filter non-xhr requests
		if (details.resourceType !== "xhr") return callback({ cancel: false });

		if (blockRegex?.test(details.url)) {
			if (!allowRegex?.test(details.url)) {
				return callback({ cancel: true });
			}
		}

		callback({ cancel: false });
	});

	console.log(pc.red("[Firewall]"), "Firewall initialized");
}

export function unstrictCSP() {
	session.defaultSession.webRequest.onHeadersReceived(({ responseHeaders, resourceType }, done) => {
		if (!responseHeaders) return done({});

		//responseHeaders["access-control-allow-origin"] = ["*"];
		if (resourceType === "mainFrame" || resourceType === "subFrame") {
			responseHeaders["content-security-policy"] = [""];
		} else if (resourceType === "stylesheet") {
			// Fix hosts that don't properly set the css content type, such as raw.githubusercontent.com
			responseHeaders["content-type"] = ["text/css"];
		}
		done({ responseHeaders });
	});
	console.log(pc.red("[Firewall]"), "Set up CSP unstricter");
}
