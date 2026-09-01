export type CheckpointState = 'clean' | 'dirty' | 'saving' | 'saving-dirty';

export class CheckpointWriter<T> {
	state: CheckpointState = 'clean';
	lastError: unknown = null;

	private latest: T | null = null;
	private revision = 0;
	private savedRevision = 0;
	private inFlight: Promise<void> | null = null;

	constructor(private readonly save: (value: T) => Promise<void>) {}

	markDirty(value: T): void {
		this.latest = value;
		this.revision += 1;
		this.state = this.inFlight ? 'saving-dirty' : 'dirty';
	}

	async flush(): Promise<void> {
		const requestedRevision = this.revision;
		while (this.savedRevision < requestedRevision) {
			if (this.inFlight) {
				await this.inFlight;
				continue;
			}

			const value = this.latest;
			if (value === null) return;
			const savingRevision = this.revision;
			this.state = 'saving';
			this.lastError = null;

			const attempt = this.save(value);
			this.inFlight = attempt;
			try {
				await attempt;
				this.savedRevision = Math.max(this.savedRevision, savingRevision);
				this.state = this.revision > this.savedRevision ? 'dirty' : 'clean';
			} catch (error) {
				this.lastError = error;
				this.state = 'dirty';
				throw error;
			} finally {
				if (this.inFlight === attempt) this.inFlight = null;
			}
		}
	}
}
