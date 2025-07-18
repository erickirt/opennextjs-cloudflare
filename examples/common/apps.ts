// List of all e2e tested apps
const apps = [
	// examples
	"create-next-app",
	"middleware",
	"playground14",
	"playground15",
	"vercel-blog-starter",
	"ssg-app",
	"prisma",
	"next-partial-prerendering",
	// e2e
	"app-pages-router",
	"app-router",
	"pages-router",
	"experimental",
	// overrides
	"d1-tag-next",
	"memory-queue",
	"r2-incremental-cache",
	"static-assets-incremental-cache",
	// bugs
	"gh-119",
	"gh-219",
	"gh-223",
] as const;

export type AppName = (typeof apps)[number];

const BASE_WRANGLER_PORT = 8770;
const BASE_NEXT_PORT = 3100;

/**
 * Returns a distinct port for each application so they can run in parallel.
 */
export function getAppPort(app: AppName, { isWorker = true } = {}) {
	const index = apps.indexOf(app);
	if (index === -1) {
		throw new Error(`Unknown app: ${app}`);
	}
	return isWorker ? BASE_WRANGLER_PORT + index : BASE_NEXT_PORT + index;
}

/**
 * Returns a distinct port for each application so they can run in parallel.
 */
export function getInspectorPort(app: AppName) {
	const index = apps.indexOf(app);
	if (index === -1) {
		throw new Error(`Unknown app: ${app}`);
	}
	return 9300 + index;
}
