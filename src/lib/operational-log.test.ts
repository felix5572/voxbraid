import { describe, expect, it } from 'vitest';
import { recordOperationalLog, resolveOperationalLog } from './operational-log';

describe('operational log', () => {
	it('deduplicates an active issue and preserves its first occurrence', () => {
		const first = recordOperationalLog(
			[],
			{ severity: 'warning', source: 'revision', code: 'offline', summary: '暂时离线' },
			{ id: 'log-1', now: '2026-09-03T10:00:00.000Z' }
		);
		const second = recordOperationalLog(
			first,
			{ severity: 'warning', source: 'revision', code: 'offline', summary: '仍然离线' },
			{ id: 'log-2', now: '2026-09-03T10:01:00.000Z' }
		);

		expect(second).toHaveLength(1);
		expect(second[0]).toMatchObject({
			id: 'log-1',
			count: 2,
			summary: '仍然离线',
			occurredAt: '2026-09-03T10:00:00.000Z',
			lastOccurredAt: '2026-09-03T10:01:00.000Z'
		});
	});

	it('marks an active issue as recovered without deleting its audit record', () => {
		const recorded = recordOperationalLog(
			[],
			{ severity: 'error', source: 'storage', code: 'quota', summary: '保存失败' },
			{ id: 'log-1', now: '2026-09-03T10:00:00.000Z' }
		);
		const resolved = resolveOperationalLog(
			recorded,
			'storage:quota::',
			'recovered',
			'2026-09-03T10:02:00.000Z'
		);

		expect(resolved[0]).toMatchObject({ state: 'recovered', count: 1 });
	});
});
