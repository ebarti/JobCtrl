// Formatting toolbar presentation. Commands are supplied by the owning editor.
import {
  type MouseEvent,
  type JSX,
  useRef,
  useId,
  useState,
  useCallback,
  useEffect,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ChangeEvent,
} from "react";
import {
  type ResumeEditorTextAlign,
  type ResumeEditorFontFamily,
  type ResumeEditorFontSize,
} from "../lib/resume-editor-types.js";
import {
  RESUME_EDITOR_DEFAULT_SIZE_PERCENT,
  RESUME_EDITOR_MIN_SIZE_PERCENT,
  RESUME_EDITOR_MAX_SIZE_PERCENT,
  RESUME_EDITOR_DEFAULT_SIZE_SCALE,
  RESUME_EDITOR_FONT_FAMILIES,
  RESUME_EDITOR_SIZE_PERCENT_STEP,
} from "../lib/resume-formatting.js";
import { normalizeResumeHrefInput } from "../lib/resume-document.js";
import { Button } from "../../../shared/ui/button.js";
import {
  IconBold,
  IconItalic,
  IconUnderline,
  IconLink,
  IconUnlink,
  IconCheck,
  IconX,
  IconAlignLeft,
  IconAlignCenter,
  IconAlignRight,
} from "@tabler/icons-react";
import { Input } from "../../../shared/ui/input.js";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "../../../shared/ui/select.js";

function keepEditorSelection(event: MouseEvent<HTMLButtonElement>): void {
  event.preventDefault();
}

function elementContainsNode(
  element: Element,
  node: Node | null | undefined,
): boolean {
  if (!node) return false;
  if (node instanceof Element) return element.contains(node);
  return node.parentElement ? element.contains(node.parentElement) : false;
}

export function ResumeEditorToolbarControls({
  disabled,
  onAlign,
  onClearLink,
  onFontFamily,
  onFontSize,
  onSetLink,
  onToggleBold,
  onToggleItalic,
  onToggleUnderline,
}: {
  readonly disabled: boolean;
  readonly onAlign: (value: ResumeEditorTextAlign) => void;
  readonly onClearLink: () => void;
  readonly onFontFamily: (value: ResumeEditorFontFamily) => void;
  readonly onFontSize: (value: ResumeEditorFontSize) => void;
  readonly onSetLink: (href: string) => void;
  readonly onToggleBold: () => void;
  readonly onToggleItalic: () => void;
  readonly onToggleUnderline: () => void;
}): JSX.Element {
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const linkInputRef = useRef<HTMLInputElement | null>(null);
  const linkTriggerRef = useRef<HTMLButtonElement | null>(null);
  const fontFamilyId = useId();
  const fontSizeId = useId();
  const linkInputId = useId();
  const linkErrorId = useId();
  const linkPopoverId = useId();
  const fontSizeDescriptionId = useId();
  const [fontSizePercent, setFontSizePercent] = useState(
    String(RESUME_EDITOR_DEFAULT_SIZE_PERCENT),
  );
  const [linkUrl, setLinkUrl] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false);
  const openLinkPopover = useCallback(() => {
    if (disabled) return;
    setLinkError(null);
    setLinkPopoverOpen(true);
  }, [disabled]);
  const closeLinkPopover = useCallback(() => {
    setLinkError(null);
    setLinkPopoverOpen(false);
    window.requestAnimationFrame(() => linkTriggerRef.current?.focus());
  }, []);
  useEffect(() => {
    if (!linkPopoverOpen) return;
    const frame = window.requestAnimationFrame(() => {
      linkInputRef.current?.focus();
      linkInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [linkPopoverOpen]);
  useEffect(() => {
    if (!linkPopoverOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const toolbar = toolbarRef.current;
      if (
        !toolbar ||
        !(event.target instanceof Node) ||
        toolbar.contains(event.target)
      )
        return;
      closeLinkPopover();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [closeLinkPopover, linkPopoverOpen]);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        disabled ||
        event.defaultPrevented ||
        event.key.toLowerCase() !== "k" ||
        (!event.metaKey && !event.ctrlKey)
      ) {
        return;
      }
      const toolbar = toolbarRef.current;
      const editor = toolbar?.closest(".resume-plate-editor");
      if (!toolbar || !editor) return;
      const activeElement = document.activeElement;
      const selection = document.getSelection();
      const activeWithinEditor =
        activeElement instanceof Element && editor.contains(activeElement);
      const selectionWithinEditor =
        Boolean(selection?.rangeCount) &&
        (elementContainsNode(editor, selection?.anchorNode) ||
          elementContainsNode(editor, selection?.focusNode));
      const selectedLineWithinEditor = Boolean(
        editor.querySelector(".jobctrl-selected-line"),
      );
      if (
        !activeWithinEditor &&
        !selectionWithinEditor &&
        !selectedLineWithinEditor
      )
        return;
      event.preventDefault();
      openLinkPopover();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [disabled, openLinkPopover]);
  const applyFontSizePercent = useCallback(
    (rawValue: string) => {
      const value = Number(rawValue);
      if (
        !Number.isFinite(value) ||
        value < RESUME_EDITOR_MIN_SIZE_PERCENT ||
        value > RESUME_EDITOR_MAX_SIZE_PERCENT
      ) {
        return;
      }
      onFontSize(Number((value / 100).toFixed(2)));
    },
    [onFontSize],
  );
  const normalizeFontSizePercent = useCallback(() => {
    const value = Number(fontSizePercent);
    if (
      !Number.isFinite(value) ||
      value < RESUME_EDITOR_MIN_SIZE_PERCENT ||
      value > RESUME_EDITOR_MAX_SIZE_PERCENT
    ) {
      setFontSizePercent(String(RESUME_EDITOR_DEFAULT_SIZE_PERCENT));
      onFontSize(RESUME_EDITOR_DEFAULT_SIZE_SCALE);
      return;
    }
    setFontSizePercent(String(Number(value.toFixed(0))));
  }, [fontSizePercent, onFontSize]);
  const applyLink = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const href = normalizeResumeHrefInput(linkUrl);
      if (!href) {
        setLinkError("Use http, https, mailto, tel, or a plain domain/email.");
        return;
      }
      setLinkError(null);
      setLinkUrl(href);
      onSetLink(href);
      closeLinkPopover();
    },
    [closeLinkPopover, linkUrl, onSetLink],
  );
  const handleLinkPopoverKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLFormElement>) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeLinkPopover();
    },
    [closeLinkPopover],
  );
  return (
    <div
      ref={toolbarRef}
      className="resume-format-toolbar"
      aria-label="Resume formatting controls"
      data-resume-editor-chrome="true"
    >
      <div className="resume-format-button-group" aria-label="Text style">
        <Button
          aria-label="Bold"
          className="resume-format-button"
          disabled={disabled}
          size="icon"
          title="Bold"
          type="button"
          onClick={onToggleBold}
          onMouseDown={keepEditorSelection}
        >
          <IconBold aria-hidden="true" size={16} stroke={2.2} />
        </Button>
        <Button
          aria-label="Italic"
          className="resume-format-button"
          disabled={disabled}
          size="icon"
          title="Italic"
          type="button"
          onClick={onToggleItalic}
          onMouseDown={keepEditorSelection}
        >
          <IconItalic aria-hidden="true" size={16} stroke={2.2} />
        </Button>
        <Button
          aria-label="Underline"
          className="resume-format-button"
          disabled={disabled}
          size="icon"
          title="Underline"
          type="button"
          onClick={onToggleUnderline}
          onMouseDown={keepEditorSelection}
        >
          <IconUnderline aria-hidden="true" size={16} stroke={2.2} />
        </Button>
      </div>
      <div className="resume-link-popover-anchor">
        <div
          className="resume-format-button-group"
          aria-label="Hyperlink actions"
        >
          <Button
            ref={linkTriggerRef}
            aria-controls={linkPopoverOpen ? linkPopoverId : undefined}
            aria-expanded={linkPopoverOpen}
            aria-keyshortcuts="Meta+K Control+K"
            aria-label="Insert link"
            className={`resume-format-button${linkPopoverOpen ? " active" : ""}`}
            disabled={disabled}
            size="icon"
            title="Insert link (⌘K)"
            type="button"
            onClick={openLinkPopover}
            onMouseDown={(event) => {
              keepEditorSelection(event);
              openLinkPopover();
            }}
          >
            <IconLink aria-hidden="true" size={16} stroke={2.2} />
          </Button>
          <Button
            aria-label="Remove link"
            className="resume-format-button"
            disabled={disabled}
            size="icon"
            title="Remove link from selected text or selected resume line"
            type="button"
            onClick={() => {
              closeLinkPopover();
              onClearLink();
            }}
            onMouseDown={keepEditorSelection}
          >
            <IconUnlink aria-hidden="true" size={16} stroke={2.2} />
          </Button>
        </div>
        {linkPopoverOpen ? (
          <form
            id={linkPopoverId}
            className="resume-link-popover"
            aria-label="Insert link"
            role="dialog"
            onKeyDown={handleLinkPopoverKeyDown}
            onSubmit={applyLink}
          >
            <label className="resume-format-select" htmlFor={linkInputId}>
              <span>URL</span>
              <Input
                ref={linkInputRef}
                aria-describedby={linkError ? linkErrorId : undefined}
                aria-invalid={linkError ? "true" : undefined}
                aria-label="Link URL"
                disabled={disabled}
                id={linkInputId}
                inputMode="url"
                placeholder="example.com"
                type="text"
                value={linkUrl}
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  setLinkUrl(event.currentTarget.value);
                  setLinkError(null);
                }}
              />
            </label>
            <div
              className="resume-format-button-group"
              aria-label="Link popover actions"
            >
              <Button
                aria-label="Apply link"
                className="resume-format-button"
                disabled={disabled || !linkUrl.trim()}
                size="icon"
                title="Apply link"
                type="submit"
                onMouseDown={keepEditorSelection}
              >
                <IconCheck aria-hidden="true" size={16} stroke={2.2} />
              </Button>
              <Button
                aria-label="Close link editor"
                className="resume-format-button"
                disabled={disabled}
                size="icon"
                title="Cancel"
                type="button"
                onClick={closeLinkPopover}
                onMouseDown={keepEditorSelection}
              >
                <IconX aria-hidden="true" size={16} stroke={2.2} />
              </Button>
            </div>
            {linkError ? (
              <span
                className="resume-link-error"
                id={linkErrorId}
                role="status"
              >
                {linkError}
              </span>
            ) : null}
          </form>
        ) : null}
      </div>
      <label className="resume-format-select" htmlFor={fontFamilyId}>
        <span>Font</span>
        <Select<ResumeEditorFontFamily>
          items={[...RESUME_EDITOR_FONT_FAMILIES]}
          defaultValue="resume"
          disabled={disabled}
          onValueChange={(nextValue) => {
            if (nextValue !== null) onFontFamily(nextValue);
          }}
        >
          <SelectTrigger
            aria-label="Font"
            id={fontFamilyId}
            className="min-w-32"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent data-resume-editor-chrome="true">
            <SelectGroup>
              {RESUME_EDITOR_FONT_FAMILIES.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </label>
      <label className="resume-format-select" htmlFor={fontSizeId}>
        <span>Size</span>
        <span className="resume-format-size-control">
          <Input
            aria-describedby={fontSizeDescriptionId}
            aria-label="Size"
            disabled={disabled}
            id={fontSizeId}
            max={RESUME_EDITOR_MAX_SIZE_PERCENT}
            min={RESUME_EDITOR_MIN_SIZE_PERCENT}
            step={RESUME_EDITOR_SIZE_PERCENT_STEP}
            title="100% uses the resume default size."
            type="number"
            value={fontSizePercent}
            onBlur={normalizeFontSizePercent}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              setFontSizePercent(event.currentTarget.value);
              applyFontSizePercent(event.currentTarget.value);
            }}
          />
          <span aria-hidden="true">%</span>
        </span>
        <span className="sr-only" id={fontSizeDescriptionId}>
          Percentage of the resume default size.
        </span>
      </label>
      <div className="resume-format-button-group" aria-label="Alignment">
        <Button
          aria-label="Align left"
          className="resume-format-button"
          disabled={disabled}
          size="icon"
          title="Align left"
          type="button"
          onClick={() => onAlign("left")}
          onMouseDown={keepEditorSelection}
        >
          <IconAlignLeft aria-hidden="true" size={16} stroke={2.2} />
        </Button>
        <Button
          aria-label="Align center"
          className="resume-format-button"
          disabled={disabled}
          size="icon"
          title="Align center"
          type="button"
          onClick={() => onAlign("center")}
          onMouseDown={keepEditorSelection}
        >
          <IconAlignCenter aria-hidden="true" size={16} stroke={2.2} />
        </Button>
        <Button
          aria-label="Align right"
          className="resume-format-button"
          disabled={disabled}
          size="icon"
          title="Align right"
          type="button"
          onClick={() => onAlign("right")}
          onMouseDown={keepEditorSelection}
        >
          <IconAlignRight aria-hidden="true" size={16} stroke={2.2} />
        </Button>
      </div>
    </div>
  );
}
