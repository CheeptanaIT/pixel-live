/**
 * A file chooser in the app's own language and style. The browser's native control says "Choose
 * File / No file chosen" in the browser's language and cannot be styled; the real input stays in
 * the page (visually hidden, still labelled and focusable) and this just dresses it up.
 */
export default function FilePick({
  title,
  ariaLabel,
  accept,
  file,
  onPick,
  resetKey,
}: {
  /** Heading shown above the button. */
  title: string;
  /** Accessible name of the file input itself. */
  ariaLabel: string;
  accept: string;
  file: File | null;
  onPick(file: File | null): void;
  /** Changing this clears the input (a file input cannot be reset any other way). */
  resetKey?: number;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 text-sm">
      <span>{title}</span>
      <label className="pixel-btn inline-flex min-h-11 cursor-pointer items-center gap-2 self-start bg-panel px-3 py-2 focus-within:outline-3 focus-within:outline-offset-2 focus-within:outline-glow">
        <input
          key={resetKey}
          type="file"
          accept={accept}
          aria-label={ariaLabel}
          onChange={(e) => onPick(e.target.files?.[0] ?? null)}
          className="sr-only"
        />
        <span aria-hidden="true">📁 เลือกรูป…</span>
      </label>
      <span data-testid="file-name" className="truncate opacity-75">
        {file ? file.name : "ยังไม่ได้เลือกไฟล์"}
      </span>
    </div>
  );
}
