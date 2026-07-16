import {
  IconArrowDown,
  IconArrowUp,
  IconColumns3,
  IconDeviceFloppy,
  IconEdit,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import type { FormEvent } from "react";
import { useMemo, useState } from "react";
import type { SavedTableView, TableId } from "@jobctrl/contracts";

import {
  DEFAULT_SAVED_TABLE_VIEW_ID,
  type SavedTablePresentation,
  type SavedTableViewSnapshot,
  useSavedTableViewsStore,
} from "../stores/saved-table-views.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog.js";
import { Input } from "./input.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select.js";

export interface SavedTableColumnOption {
  id: string;
  label: string;
  locked?: boolean;
}

export interface SavedTableViewsControlProps {
  tableId: TableId;
  columnOptions: readonly SavedTableColumnOption[];
  snapshot: SavedTableViewSnapshot;
  onApplyView: (view: SavedTableView) => void;
  onPresentationChange: (presentation: SavedTablePresentation) => void;
}

const COLOR_RULE_OPERATORS = [
  { value: "contains", label: "contains" },
  { value: "eq", label: "equals" },
  { value: "neq", label: "not equal" },
  { value: "gte", label: ">=" },
  { value: "lte", label: "<=" },
] as const;
const COLOR_RULE_TONES = [
  { value: "success", label: "Success" },
  { value: "warning", label: "Warning" },
  { value: "danger", label: "Danger" },
  { value: "info", label: "Info" },
] as const;

function moveColumn(
  order: readonly string[],
  columnId: string,
  delta: -1 | 1,
): string[] {
  const index = order.indexOf(columnId);
  const nextIndex = index + delta;
  if (index < 0 || nextIndex < 0 || nextIndex >= order.length) {
    return [...order];
  }
  const next = [...order];
  const [item] = next.splice(index, 1);
  next.splice(nextIndex, 0, item!);
  return next;
}

function viewNameForInput(value: string): string {
  return value.trim().slice(0, 80);
}

export function SavedTableViewsControl({
  tableId,
  columnOptions,
  snapshot,
  onApplyView,
  onPresentationChange,
}: SavedTableViewsControlProps) {
  const allViews = useSavedTableViewsStore((state) => state.views);
  const views = useMemo(
    () => allViews.filter((view) => view.tableId === tableId),
    [allViews, tableId],
  );
  const activeViewId = useSavedTableViewsStore(
    (state) =>
      state.activeViewIdByTable[tableId] ?? DEFAULT_SAVED_TABLE_VIEW_ID,
  );
  const applyView = useSavedTableViewsStore((state) => state.applyView);
  const createView = useSavedTableViewsStore((state) => state.createView);
  const updateActiveView = useSavedTableViewsStore(
    (state) => state.updateActiveView,
  );
  const renameView = useSavedTableViewsStore((state) => state.renameView);
  const deleteView = useSavedTableViewsStore((state) => state.deleteView);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [columnOpen, setColumnOpen] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [renameInput, setRenameInput] = useState("");
  const [ruleColumnId, setRuleColumnId] = useState("");
  const [ruleOperator, setRuleOperator] =
    useState<(typeof COLOR_RULE_OPERATORS)[number]["value"]>("contains");
  const [ruleValue, setRuleValue] = useState("");
  const [ruleTone, setRuleTone] =
    useState<(typeof COLOR_RULE_TONES)[number]["value"]>("info");

  const activeView = useMemo(
    () =>
      views.find((view) => view.id === activeViewId) ??
      views.find((view) => view.id === DEFAULT_SAVED_TABLE_VIEW_ID),
    [activeViewId, views],
  );
  const defaultView = useMemo(
    () => views.find((view) => view.id === DEFAULT_SAVED_TABLE_VIEW_ID),
    [views],
  );
  const visibleIds = useMemo(
    () =>
      columnOptions
        .map((column) => column.id)
        .filter((columnId) => !snapshot.columns.hidden.includes(columnId)),
    [columnOptions, snapshot.columns.hidden],
  );
  const viewItems = useMemo(
    () => views.map((view) => ({ value: view.id, label: view.name })),
    [views],
  );
  const columnItems = useMemo(
    () =>
      columnOptions.map((column) => ({
        value: column.id,
        label: column.label,
      })),
    [columnOptions],
  );
  const groupingItems = useMemo(
    () => [{ value: null, label: "No grouping" }, ...columnItems],
    [columnItems],
  );

  const setPresentation = (presentation: SavedTablePresentation) => {
    onPresentationChange(presentation);
  };

  const applySelectedView = (viewId: string) => {
    const nextView =
      views.find((view) => view.id === viewId) ?? defaultView ?? null;
    if (!nextView) return;
    applyView(tableId, nextView.id);
    onApplyView(nextView);
  };

  const submitSaveAs = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = viewNameForInput(nameInput);
    if (!name) return;
    createView(tableId, name, snapshot);
    setSaveAsOpen(false);
    setNameInput("");
  };

  const submitRename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeView) return;
    const name = viewNameForInput(renameInput);
    if (!name) return;
    if (renameView(tableId, activeView.id, name)) {
      setRenameOpen(false);
    }
  };

  const updateCurrentView = () => {
    updateActiveView(tableId, snapshot);
  };

  const deleteCurrentView = () => {
    if (!activeView || activeView.builtIn) return;
    if (!window.confirm(`Delete saved view "${activeView.name}"?`)) return;
    const deletingActive = activeView.id === activeViewId;
    if (deleteView(tableId, activeView.id) && deletingActive && defaultView) {
      onApplyView(defaultView);
    }
  };

  const toggleColumn = (columnId: string) => {
    const hidden = new Set(snapshot.columns.hidden);
    if (hidden.has(columnId)) {
      hidden.delete(columnId);
    } else if (visibleIds.length > 1) {
      hidden.add(columnId);
    }
    setPresentation({
      columns: { ...snapshot.columns, hidden: [...hidden] },
      density: snapshot.density,
      grouping: snapshot.grouping,
      colorRules: snapshot.colorRules,
    });
  };

  const reorderColumn = (columnId: string, delta: -1 | 1) => {
    setPresentation({
      columns: {
        ...snapshot.columns,
        order: moveColumn(snapshot.columns.order, columnId, delta),
      },
      density: snapshot.density,
      grouping: snapshot.grouping,
      colorRules: snapshot.colorRules,
    });
  };

  const setDensity = (density: SavedTablePresentation["density"]) => {
    setPresentation({
      columns: snapshot.columns,
      density,
      grouping: snapshot.grouping,
      colorRules: snapshot.colorRules,
    });
  };

  const setGrouping = (columnId: string) => {
    setPresentation({
      columns: snapshot.columns,
      density: snapshot.density,
      grouping: columnId ? { columnId } : null,
      colorRules: snapshot.colorRules,
    });
  };

  const addColorRule = () => {
    const columnId = ruleColumnId || columnOptions[0]?.id;
    const trimmedValue = ruleValue.trim();
    if (!columnId || !trimmedValue) return;
    const numericValue = Number(trimmedValue);
    const value =
      (ruleOperator === "gte" || ruleOperator === "lte") &&
      Number.isFinite(numericValue)
        ? numericValue
        : trimmedValue;
    setPresentation({
      columns: snapshot.columns,
      density: snapshot.density,
      grouping: snapshot.grouping,
      colorRules: [
        ...snapshot.colorRules,
        {
          columnId,
          predicate: { op: ruleOperator, value },
          tone: ruleTone,
        },
      ],
    });
    setRuleValue("");
  };

  const deleteColorRule = (index: number) => {
    setPresentation({
      columns: snapshot.columns,
      density: snapshot.density,
      grouping: snapshot.grouping,
      colorRules: snapshot.colorRules.filter(
        (_, ruleIndex) => ruleIndex !== index,
      ),
    });
  };

  return (
    <div className="saved-table-views-control data-table-views">
      <label className="saved-table-views-select">
        <span>View</span>
        <Select
          items={viewItems}
          value={activeView?.id ?? DEFAULT_SAVED_TABLE_VIEW_ID}
          onValueChange={(viewId) => {
            if (viewId !== null) applySelectedView(viewId);
          }}
        >
          <SelectTrigger
            aria-label="Saved table view"
            className="max-w-40"
            size="sm"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            <SelectGroup>
              {viewItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </label>
      <button
        type="button"
        aria-label="Save current view"
        title="Save current view"
        disabled={!activeView || activeView.builtIn}
        onClick={updateCurrentView}
      >
        <IconDeviceFloppy size={14} aria-hidden="true" />
      </button>
      <Dialog open={saveAsOpen} onOpenChange={setSaveAsOpen}>
        <DialogTrigger asChild>
          <button type="button" aria-label="Save as view" title="Save as view">
            <IconPlus size={14} aria-hidden="true" />
          </button>
        </DialogTrigger>
        <DialogContent className="saved-table-view-dialog">
          <DialogHeader>
            <DialogTitle>Save view</DialogTitle>
            <DialogDescription>
              Save the current table template under a new name.
            </DialogDescription>
          </DialogHeader>
          <form className="saved-table-view-form" onSubmit={submitSaveAs}>
            <label className="field">
              <span>Name</span>
              <Input
                autoFocus
                value={nameInput}
                maxLength={80}
                onChange={(event) => setNameInput(event.target.value)}
              />
            </label>
            <DialogFooter>
              <button type="submit" disabled={!nameInput.trim()}>
                Save
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={renameOpen}
        onOpenChange={(open) => {
          setRenameOpen(open);
          if (open) setRenameInput(activeView?.name ?? "");
        }}
      >
        <DialogTrigger asChild>
          <button
            type="button"
            aria-label="Rename view"
            title="Rename view"
            disabled={!activeView || activeView.builtIn}
          >
            <IconEdit size={14} aria-hidden="true" />
          </button>
        </DialogTrigger>
        <DialogContent className="saved-table-view-dialog">
          <DialogHeader>
            <DialogTitle>Rename view</DialogTitle>
            <DialogDescription>
              Rename the selected saved view.
            </DialogDescription>
          </DialogHeader>
          <form className="saved-table-view-form" onSubmit={submitRename}>
            <label className="field">
              <span>Name</span>
              <Input
                autoFocus
                value={renameInput}
                maxLength={80}
                onChange={(event) => setRenameInput(event.target.value)}
              />
            </label>
            <DialogFooter>
              <button type="submit" disabled={!renameInput.trim()}>
                Rename
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <button
        type="button"
        aria-label="Delete view"
        title="Delete view"
        disabled={!activeView || activeView.builtIn}
        onClick={deleteCurrentView}
      >
        <IconTrash size={14} aria-hidden="true" />
      </button>
      <Dialog open={columnOpen} onOpenChange={setColumnOpen}>
        <DialogTrigger asChild>
          <button
            type="button"
            aria-label="Configure table columns"
            title="Configure table columns"
          >
            <IconColumns3 size={14} aria-hidden="true" />
          </button>
        </DialogTrigger>
        <DialogContent className="saved-table-columns-dialog">
          <DialogHeader>
            <DialogTitle>Columns</DialogTitle>
            <DialogDescription>
              Choose columns, order, and table density for this table.
            </DialogDescription>
          </DialogHeader>
          <section className="saved-table-density" aria-label="Table density">
            {[
              { value: null, label: "Inherit" },
              { value: "compact", label: "Compact" },
              { value: "regular", label: "Regular" },
              { value: "comfy", label: "Comfy" },
            ].map((option) => (
              <button
                key={option.label}
                type="button"
                aria-pressed={snapshot.density === option.value}
                onClick={() =>
                  setDensity(option.value as SavedTablePresentation["density"])
                }
              >
                {option.label}
              </button>
            ))}
          </section>
          <label className="saved-table-rule-field">
            <span>Group by</span>
            <Select
              items={groupingItems}
              value={snapshot.grouping?.columnId ?? null}
              onValueChange={(columnId) => setGrouping(columnId ?? "")}
            >
              <SelectTrigger aria-label="Group table rows" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {groupingItems.map((item) => (
                    <SelectItem key={item.value ?? "none"} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </label>
          <section className="saved-table-rules" aria-label="Color rules">
            <div className="saved-table-rule-editor">
              <label>
                <span>Column</span>
                <Select
                  items={columnItems}
                  value={ruleColumnId || columnOptions[0]?.id || null}
                  onValueChange={(columnId) => setRuleColumnId(columnId ?? "")}
                >
                  <SelectTrigger
                    aria-label="Color rule column"
                    className="w-full"
                  >
                    <SelectValue placeholder="Select column" />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {columnItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </label>
              <label>
                <span>Predicate</span>
                <Select
                  items={COLOR_RULE_OPERATORS}
                  value={ruleOperator}
                  onValueChange={(operator) =>
                    operator !== null && setRuleOperator(operator)
                  }
                >
                  <SelectTrigger
                    aria-label="Color rule predicate"
                    className="w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {COLOR_RULE_OPERATORS.map((operator) => (
                        <SelectItem key={operator.value} value={operator.value}>
                          {operator.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </label>
              <label>
                <span>Value</span>
                <Input
                  aria-label="Color rule value"
                  value={ruleValue}
                  onChange={(event) => setRuleValue(event.target.value)}
                />
              </label>
              <label>
                <span>Tone</span>
                <Select
                  items={COLOR_RULE_TONES}
                  value={ruleTone}
                  onValueChange={(tone) => tone !== null && setRuleTone(tone)}
                >
                  <SelectTrigger
                    aria-label="Color rule tone"
                    className="w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {COLOR_RULE_TONES.map((tone) => (
                        <SelectItem key={tone.value} value={tone.value}>
                          {tone.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </label>
              <button
                type="button"
                disabled={!ruleValue.trim()}
                onClick={addColorRule}
              >
                Add
              </button>
            </div>
            {snapshot.colorRules.length ? (
              <div className="saved-table-rule-list">
                {snapshot.colorRules.map((rule, index) => {
                  const column = columnOptions.find(
                    (option) => option.id === rule.columnId,
                  );
                  return (
                    <div key={`${rule.columnId}-${index}`}>
                      <span>
                        {column?.label ?? rule.columnId} {rule.predicate.op}{" "}
                        {String(rule.predicate.value)} · {rule.tone}
                      </span>
                      <button
                        type="button"
                        aria-label={`Delete color rule ${index + 1}`}
                        onClick={() => deleteColorRule(index)}
                      >
                        <IconTrash size={13} aria-hidden="true" />
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </section>
          <div className="saved-table-column-list">
            {snapshot.columns.order.map((columnId, index) => {
              const column = columnOptions.find(
                (option) => option.id === columnId,
              );
              if (!column) return null;
              const visible = !snapshot.columns.hidden.includes(columnId);
              const canHide =
                !column.locked && (visibleIds.length > 1 || !visible);
              return (
                <div key={column.id} className="saved-table-column-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={visible}
                      disabled={!canHide}
                      onChange={() => toggleColumn(column.id)}
                    />
                    <span>{column.label}</span>
                  </label>
                  <div>
                    <button
                      type="button"
                      aria-label={`Move ${column.label} earlier`}
                      title={`Move ${column.label} earlier`}
                      disabled={index === 0}
                      onClick={() => reorderColumn(column.id, -1)}
                    >
                      <IconArrowUp size={13} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${column.label} later`}
                      title={`Move ${column.label} later`}
                      disabled={index === snapshot.columns.order.length - 1}
                      onClick={() => reorderColumn(column.id, 1)}
                    >
                      <IconArrowDown size={13} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
