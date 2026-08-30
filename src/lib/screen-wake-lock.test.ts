import { describe, expect, it, vi } from 'vitest';
import { ScreenWakeLock, type ScreenWakeLockProvider } from './screen-wake-lock';

class FakeWakeLockSentinel extends EventTarget {
	released = false;
	readonly type = 'screen' as const;
	onrelease: ((this: WakeLockSentinel, event: Event) => unknown) | null = null;
	readonly release = vi.fn(async () => {
		this.released = true;
		this.dispatchEvent(new Event('release'));
	});
}

describe('ScreenWakeLock', () => {
	it('deduplicates repeated requests and releases the held sentinel', async () => {
		const sentinel = new FakeWakeLockSentinel();
		const provider: ScreenWakeLockProvider = {
			request: vi.fn(async () => sentinel as unknown as WakeLockSentinel)
		};
		const wakeLock = new ScreenWakeLock({
			getProvider: () => provider,
			isVisible: () => true
		});

		await Promise.all([wakeLock.acquire(), wakeLock.acquire()]);
		await wakeLock.release();

		expect(provider.request).toHaveBeenCalledOnce();
		expect(sentinel.release).toHaveBeenCalledOnce();
	});

	it('releases a sentinel that arrives after the lock is no longer wanted', async () => {
		let resolveRequest!: (sentinel: WakeLockSentinel) => void;
		const sentinel = new FakeWakeLockSentinel();
		const provider: ScreenWakeLockProvider = {
			request: vi.fn(
				() =>
					new Promise<WakeLockSentinel>((resolve) => {
						resolveRequest = resolve;
					})
			)
		};
		const wakeLock = new ScreenWakeLock({
			getProvider: () => provider,
			isVisible: () => true
		});

		const requestPromise = wakeLock.acquire();
		await wakeLock.release();
		resolveRequest(sentinel as unknown as WakeLockSentinel);
		await requestPromise;

		expect(sentinel.release).toHaveBeenCalledOnce();
	});
});
