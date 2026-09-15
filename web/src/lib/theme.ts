/**
 * Runtime theming of the web dashboard, driven by the server's
 * `appearance` config (`~/.wherever/config.json`). Because the brand
 * palette is defined as Tailwind v4 `@theme` variables (`--color-brand-*`),
 * every `bg-brand-*` / `text-brand-*` / `border-brand-*` utility resolves
 * those custom properties at paint time: overriding them on the root
 * element re-themes the whole UI without a rebuild.
 *
 * This exists so machines that mirror the same pi sessions (e.g. via
 * cloned folders pushed over git) can be told apart at a glance: each
 * server instance gets its own accent color and label.
 */

/** Brand color token keys shared with `AppearanceConfig` on the server. */
export type AppearanceColorKey =
	| 'brandDark'
	| 'brandSurface'
	| 'brandSurface2'
	| 'brandSurface3'
	| 'brandBorder'
	| 'brandText'
	| 'brandTextMuted'
	| 'brandCyan'
	| 'brandBlue'
	| 'brandPurple';

/** Subtle backdrop patterns painted on the dashboard's dark background, in the accent tint. */
export type AppearancePattern = 'none' | 'stripes' | 'dots' | 'grid';

export interface AppearanceInfo {
	/** Instance label (defaults to the server machine's hostname). */
	label: string;
	/** Accent color overriding the brand accent tokens, or null. */
	accent: string | null;
	/** Per-token brand overrides, or null. */
	colors: Partial<Record<AppearanceColorKey, string>> | null;
	/** Solid accent bar across the top edge of the whole dashboard. */
	frame: boolean;
	/** Backdrop pattern on the dark background, in the accent tint. */
	pattern: AppearancePattern;
}

/** Map of config color keys to the CSS custom properties they override. */
const TOKEN_VARS: Record<AppearanceColorKey, string> = {
	brandDark: '--color-brand-dark',
	brandSurface: '--color-brand-surface',
	brandSurface2: '--color-brand-surface-2',
	brandSurface3: '--color-brand-surface-3',
	brandBorder: '--color-brand-border',
	brandText: '--color-brand-text',
	brandTextMuted: '--color-brand-text-muted',
	brandCyan: '--color-brand-cyan',
	brandBlue: '--color-brand-blue',
	brandPurple: '--color-brand-purple',
};

const ACCENT_VARS = [
	'--color-brand-cyan',
	'--color-brand-blue',
	'--color-brand-purple',
];

/** The appearance assumed before /config answers (the compiled defaults). */
export const defaultAppearance: AppearanceInfo = {
	label: '',
	accent: null,
	colors: null,
	frame: false,
	pattern: 'none',
};

/**
 * Apply an appearance to the document. Values are written through
 * `style.setProperty` only (never innerHTML), so arbitrary config strings
 * cannot inject markup. Pass `defaultAppearance` to reset to the compiled
 * palette (e.g. when connecting to a different server).
 */
export function applyAppearance(appearance: AppearanceInfo): void {
	if (typeof document === 'undefined') return;
	const root = document.documentElement;

	// Reset first: /config answers once per server, and a PWA reconnecting to
	// another instance must not blend two palettes.
	for (const cssVar of Object.values(TOKEN_VARS)) {
		root.style.removeProperty(cssVar);
	}
	root.classList.remove('wherever-framed');
	delete root.dataset.whereverPattern;

	if (appearance.accent) {
		// One accent color retints the gradient stops too (app.css builds the
		// gradient from these variables), giving each instance a uniform hue.
		for (const cssVar of ACCENT_VARS) {
			root.style.setProperty(cssVar, appearance.accent);
		}
		// Match the mobile browser chrome / PWA status bar to the accent.
		document
			.querySelector('meta[name="theme-color"]')
			?.setAttribute('content', appearance.accent);
	}

	if (appearance.frame) {
		// A solid accent bar over the top edge of everything (app.css), visible
		// even with the sidebar collapsed or a session filling the screen.
		root.classList.add('wherever-framed');
	}
	if (appearance.pattern && appearance.pattern !== 'none') {
		// The backdrop pattern (app.css) reads this attribute.
		root.dataset.whereverPattern = appearance.pattern;
	}

	if (appearance.colors) {
		for (const [key, value] of Object.entries(appearance.colors) as [
			AppearanceColorKey,
			string,
		][]) {
			const cssVar = TOKEN_VARS[key];
			if (cssVar && typeof value === 'string') {
				root.style.setProperty(cssVar, value);
			}
		}
	}
}
