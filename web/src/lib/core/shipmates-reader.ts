/**
 * The Needs you READER: one inbox question shown large (a modal on desktop, a
 * full-screen sheet on the phone), with its Markdown rendered, every option as
 * a full-width button and a multi-line answer box. The Needs you list stays
 * compact (each question clamped to three lines) and opens the reader for the
 * rest; the question toast's "Answer in Needs you" opens it too.
 *
 * Which question is open is one id, shared by every opener: `readerItemId`.
 * The rules (what counts as long, the ‹ › steps, what happens when the open
 * question leaves the inbox) are pure functions of the inbox, tested beside.
 */
import {writable} from 'svelte/store';
import type {ShipmatesInboxItem} from './shipmates';

/** The inbox item the reader shows, or null when it is closed. */
export const readerItemId = writable<string | null>(null);

export function openReader(id: string): void {
	readerItemId.set(id);
}

export function closeReader(): void {
	readerItemId.set(null);
}

/** A question longer than this (characters) is clamped in the list. */
export const LONG_QUESTION_CHARS = 160;
/** More lines than this is clamped in the list (the clamp is three lines). */
export const LONG_QUESTION_LINES = 3;
/** Options whose labels add up to more than this go to the reader. */
export const LONG_OPTIONS_CHARS = 60;

/**
 * Whether the list shows this question clamped with a "Read" call to action
 * instead of answering in place: a long question, or options too long or too
 * many to sit as chips in the narrow sidebar. A short question keeps its
 * chips and answer field in the list (one tap for a yes / no), with a small
 * "Read" beside them.
 */
export function isLongQuestion(
	item: Pick<ShipmatesInboxItem, 'question' | 'options'>,
): boolean {
	const q = item.question ?? '';
	if (q.length > LONG_QUESTION_CHARS) return true;
	if (q.split('\n').length > LONG_QUESTION_LINES) return true;
	const opts = item.options ?? [];
	const optChars = opts.reduce((n, o) => n + o.length, 0);
	return optChars > LONG_OPTIONS_CHARS;
}

export interface ReaderPosition {
	/** The open item, or null when it is not in the inbox (anymore). */
	item: ShipmatesInboxItem | null;
	/** 1-based position in the inbox, 0 when not found. */
	index: number;
	total: number;
	prevId: string | null;
	nextId: string | null;
}

/** Where the open question sits in the inbox, for the ‹ n of N › steps. */
export function readerPosition(
	inbox: readonly ShipmatesInboxItem[],
	id: string | null,
): ReaderPosition {
	const i = id === null ? -1 : inbox.findIndex((it) => it.id === id);
	if (i < 0)
		return {
			item: null,
			index: 0,
			total: inbox.length,
			prevId: null,
			nextId: null,
		};
	return {
		item: inbox[i],
		index: i + 1,
		total: inbox.length,
		prevId: i > 0 ? inbox[i - 1].id : null,
		nextId: i < inbox.length - 1 ? inbox[i + 1].id : null,
	};
}

/**
 * The option a digit key picks (1 is the first option), or null. Only plain
 * digits 1 to 9 count, so typing in the answer box is never taken.
 */
export function optionForKey(
	options: readonly string[] | null,
	key: string,
): string | null {
	if (!options?.length || !/^[1-9]$/.test(key)) return null;
	return options[Number(key) - 1] ?? null;
}
