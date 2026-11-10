import type { SyncApi } from "../client/index.js";
import { type UseSyncOptions } from "../tiptap/index.js";
import { BlockNoteEditor, type BlockNoteEditorOptions } from "@blocknote/core";
import type { JSONContent } from "@tiptap/core";
export type BlockNoteSyncOptions<Editor = BlockNoteEditor> = UseSyncOptions & {
    /**
     * If you pass options into the editor, you should pass them here, to ensure
     * the initialContent is parsed with the correct schema.
     */
    editorOptions?: Partial<Omit<BlockNoteEditorOptions<any, any, any>, "initialContent">>;
    /**
     * @deprecated Do `useBlockNoteSync<BlockNoteEditor>` instead.
     *
     */
    BlockNoteEditor?: Editor;
};
/**
 * A hook to sync a BlockNote editor with a Convex document.
 *
 * Usually used like:
 *
 * ```tsx
 * const sync = useBlockNoteSync(api.example, "some-id");
 * ```
 *
 * If you see an error like:
 * ```
 * Property 'options' is protected but type 'BlockNoteEditor<BSchema, ISchema, SSchema>' is not a class derived from 'BlockNoteEditor<BSchema, ISchema, SSchema>'.
 * ```
 * You can pass your own BlockNoteEditor like:
 * ```tsx
 * import { BlockNoteEditor } from "@blocknote/core";
 * //...
 * const sync = useBlockNoteSync<BlockNoteEditor>(api.example, "some-id");
 * ```
 * This is a workaround for the types of your editor not matching the editor
 * version used by prosemirror-sync.
 *
 * @param syncApi Wherever you exposed the sync api, e.g. `api.example`.
 * @param id The document ID.
 * @param opts Options to pass to the underlying BlockNoteEditor and sync opts.
 * @returns The editor, loading state, and fn to create the initial document.
 */
export declare function useBlockNoteSync<Editor = BlockNoteEditor>(syncApi: SyncApi, id: string, opts?: BlockNoteSyncOptions<Editor>): {
    editor: null;
    isLoading: true;
    create?: (content: JSONContent) => Promise<void>;
} | {
    editor: null;
    isLoading: false;
    create?: (content: JSONContent) => Promise<void>;
} | {
    editor: Editor;
    isLoading: false;
};
//# sourceMappingURL=index.d.ts.map