const INSTANCE_UPDATE_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

window.goofcord.onInvidiousConfigChanged(updateInvidiousInstance);

export async function updateInvidiousInstance() {
	if (!GoofCord.getConfig("invidiousEmbeds")) return;

	window.invidiousInstance = GoofCord.getConfig("invidiousInstance");

	if (GoofCord.getConfig("autoUpdateInvidiousInstance")) {
		const lastUpdate = GoofCord.getConfig("lastInvidiousUpdate") ?? 0;
		const now = Date.now();
		const needsUpdate = now - lastUpdate > INSTANCE_UPDATE_INTERVAL;
		if (needsUpdate) {
			try {
				console.log("Updating Invidious instance...");
				const newInstance = await findFastestInstance();

				window.invidiousInstance = newInstance;
				void GoofCord.setConfig("invidiousInstance", newInstance);
				void GoofCord.setConfig("lastInvidiousUpdate", now);

				console.log("Invidious instance updated:", newInstance);
			} catch (error) {
				console.error("Failed to update Invidious instance:", error);
			}
		}
	}
}

async function findFastestInstance() {
	const response = await fetchWithTimeout("https://api.invidious.io/instances.json?pretty=0&sort_by=type,users", {}, 10000);
	if (!response.ok) throw new Error(`Invidious instance list returned HTTP ${response.status}`);
	const json = await response.json();
	const instances = json.map((instance: { uri: string }[]) => instance[1].uri);

	console.log("Testing Invidious instances...");
	let prevBestTime = Infinity;
	let prevBestInstance = null;
	for (const instance of instances) {
		if (!instance.includes("https")) continue;
		const start = performance.now();
		try {
			await fetchWithTimeout(instance + "/embed/5IXQ6f6eMxQ?autoplay=1&player_style=youtube&local=true", {
				mode: "no-cors",
			}, 5000);
		} catch (e) {}
		const end = performance.now();
		const time = end - start;
		console.log(instance, time);
		if (time < prevBestTime) {
			prevBestTime = time;
			prevBestInstance = instance;
		}
	}

	console.log("Fastest instance:", prevBestInstance, prevBestTime);
	return prevBestInstance;
}

async function fetchWithTimeout(input: string, init: RequestInit = {}, timeoutMs = 10000): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	try {
		return await fetch(input, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
}
