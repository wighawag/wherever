import {getContext, setContext} from 'svelte';

/** What a `Menu` gives its items (`MenuItem`, `MenuSeparator`). */
export interface MenuContext {
	/** Close the menu and give the focus back to its trigger. */
	close(): void;
	/** True while the menu shows as a bottom sheet (below `md`). */
	readonly sheet: boolean;
}

const KEY = Symbol('menu');

export function setMenuContext(ctx: MenuContext): void {
	setContext(KEY, ctx);
}

/** The enclosing menu, or undefined when an item is used outside one. */
export function getMenuContext(): MenuContext | undefined {
	return getContext<MenuContext | undefined>(KEY);
}

/** The props a `Menu` hands its `trigger` snippet, to spread on the button. */
export interface MenuTriggerProps {
	onclick: (e: MouseEvent) => void;
	'aria-haspopup': 'menu';
	'aria-expanded': boolean;
	'data-menu-trigger': '';
}
