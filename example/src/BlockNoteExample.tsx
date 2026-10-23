import { useBlockNoteSync } from "@convex-dev/prosemirror-sync/blocknote";
import "@blocknote/core/fonts/inter.css";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import { api } from "../convex/_generated/api";
import { BlockNoteEditor } from "@blocknote/core";

export function BlockNoteExample(props: { id: string }) {
  const sync = useBlockNoteSync<BlockNoteEditor>(api.example, props.id, {
    debug: true,
  });
  if (
    !sync.isLoading &&
    sync.editor === null &&
    typeof sync.create === "function"
  ) {
    sync.create({ type: "doc", content: [] });
  }
  return sync.editor ? (
    <BlockNoteView editor={sync.editor} />
  ) : (
    <div>Loading...</div>
  );
}
