declare global {
	namespace App {}

	const __VOXBRAID_BUILD_INFO__: Readonly<{
		commitSha: string;
		commitMessage: string;
		dirty: boolean;
	}>;
}

export {};
