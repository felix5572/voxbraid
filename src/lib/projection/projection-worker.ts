export interface ProjectionPolicy<Run, Cursor, Options, Candidate, Progress> {
	nextCandidate(run: Run, cursor: Cursor, options: Options): Candidate | null;
	progress(run: Run, cursor: Cursor, options: Options): Progress;
}

interface InFlightProjectionRequest {
	id: string;
	targetId: string;
}

export class ProjectionWorker {
	#inFlight: InFlightProjectionRequest | null = null;
	#loadGeneration = 0;

	get currentRequestId(): string | null {
		return this.#inFlight?.id ?? null;
	}

	get requesting(): boolean {
		return this.#inFlight !== null;
	}

	beginRequest(id: string, targetId: string): void {
		if (this.#inFlight)
			throw new Error(`Projection request already in flight: ${this.#inFlight.id}.`);
		this.#inFlight = { id, targetId };
	}

	ownsRequest(id: string, targetId?: string): boolean {
		return (
			this.#inFlight?.id === id && (targetId === undefined || this.#inFlight.targetId === targetId)
		);
	}

	finishRequest(id: string): boolean {
		if (!this.ownsRequest(id)) return false;
		this.#inFlight = null;
		return true;
	}

	cancelRequest(): string | null {
		const id = this.currentRequestId;
		this.#inFlight = null;
		return id;
	}

	beginLoad(): number {
		this.#loadGeneration += 1;
		return this.#loadGeneration;
	}

	ownsLoad(generation: number): boolean {
		return generation === this.#loadGeneration;
	}
}
