import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite';

interface BuildInfo {
	commitSha: string;
	commitMessage: string;
	dirty: boolean;
}

function gitOutput(args: string[]): string | null {
	try {
		return execFileSync('git', args, {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore']
		}).trim();
	} catch {
		return null;
	}
}

function buildInfo(): BuildInfo {
	const railwaySha = process.env.RAILWAY_GIT_COMMIT_SHA?.trim();
	const railwayMessage = process.env.RAILWAY_GIT_COMMIT_MESSAGE?.trim();
	const commitSha = (railwaySha || gitOutput(['rev-parse', 'HEAD']) || 'local').slice(0, 8);
	const commitMessage = (railwayMessage || gitOutput(['log', '-1', '--format=%s']) || '本地构建')
		.split(/\r?\n/, 1)[0]
		.slice(0, 160);
	const dirty = railwaySha ? false : Boolean(gitOutput(['status', '--porcelain']));

	return { commitSha, commitMessage, dirty };
}

export default defineConfig({
	define: {
		__VOXBRAID_BUILD_INFO__: JSON.stringify(buildInfo())
	},
	plugins: [
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter()
		})
	]
});
