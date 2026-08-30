export interface ScreenWakeLockProvider {
	request(type: 'screen'): Promise<WakeLockSentinel>;
}

interface ScreenWakeLockOptions {
	getProvider?: () => ScreenWakeLockProvider | null;
	isVisible?: () => boolean;
}

function browserWakeLockProvider(): ScreenWakeLockProvider | null {
	if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return null;
	return navigator.wakeLock;
}

function browserIsVisible(): boolean {
	return typeof document !== 'undefined' && document.visibilityState === 'visible';
}

export class ScreenWakeLock {
	private sentinel: WakeLockSentinel | null = null;
	private requestPromise: Promise<void> | null = null;
	private requested = false;
	private readonly getProvider: () => ScreenWakeLockProvider | null;
	private readonly isVisible: () => boolean;

	constructor(options: ScreenWakeLockOptions = {}) {
		this.getProvider = options.getProvider ?? browserWakeLockProvider;
		this.isVisible = options.isVisible ?? browserIsVisible;
	}

	acquire(): Promise<void> {
		this.requested = true;
		if (this.sentinel || this.requestPromise || !this.isVisible()) {
			return this.requestPromise ?? Promise.resolve();
		}

		const provider = this.getProvider();
		if (!provider) return Promise.resolve();

		const requestPromise = provider
			.request('screen')
			.then(async (sentinel) => {
				if (!this.requested || !this.isVisible()) {
					await sentinel.release().catch(() => undefined);
					return;
				}

				this.sentinel = sentinel;
				sentinel.addEventListener(
					'release',
					() => {
						if (this.sentinel === sentinel) this.sentinel = null;
					},
					{ once: true }
				);
			})
			.catch(() => undefined)
			.finally(() => {
				if (this.requestPromise === requestPromise) this.requestPromise = null;
			});

		this.requestPromise = requestPromise;
		return requestPromise;
	}

	async release(): Promise<void> {
		this.requested = false;
		const sentinel = this.sentinel;
		this.sentinel = null;
		if (sentinel) await sentinel.release().catch(() => undefined);
	}
}
