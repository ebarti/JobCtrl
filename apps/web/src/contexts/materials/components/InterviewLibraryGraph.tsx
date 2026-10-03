import { Fragment, useMemo, useRef, useState, type PointerEvent } from "react";

import type { InterviewCatalog, InterviewQuestionCard } from "../../operations/types.js";
import { Button } from "../../../shared/ui/button.js";

interface Props {
  readonly catalog: InterviewCatalog;
  readonly questions: readonly InterviewQuestionCard[];
  readonly selectedQuestionId: string;
  readonly topicId: string;
  readonly sourceId: string;
  readonly onSelectQuestion: (id: string) => void;
  readonly onSelectTopic: (id: string) => void;
  readonly onSelectSource: (id: string) => void;
  readonly onOverview: () => void;
}
interface Group { id: string; label: string; children: { id: string; label: string }[] }
const RESPONSIVE_LAYOUTS = [
  { name: "wide", columns: 4, rowHeight: 260, center: 90 },
  { name: "medium", columns: 3, rowHeight: 260, center: 90 },
  { name: "small", columns: 3, rowHeight: 160, center: 32 },
] as const;

// A 28px hexagonal lattice keeps native 24px targets disjoint, including
// dense author groups. The centre is reserved for the topic/author action.
function satellitePositions(count: number) {
  const positions: { x: number; y: number }[] = [];
  for (let ring = 1; positions.length < count; ring++) {
    const points: { x: number; y: number }[] = [];
    for (let q = -ring; q <= ring; q++) {
      for (let r = -ring; r <= ring; r++) {
        if (Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) === ring) points.push({ x: 28 * (q + r / 2), y: 28 * Math.sqrt(3) / 2 * r });
      }
    }
    // Partial outer rings grow vertically first, keeping narrow columns usable.
    points.sort((a, b) => Math.abs(a.x) - Math.abs(b.x) || a.y - b.y || a.x - b.x);
    positions.push(...points.slice(0, count - positions.length));
  }
  return positions;
}

// The overview has one native button per card/source. Only decorative linework
// changes with container width; no ResizeObserver, canvas, or browser port is needed.
export function InterviewLibraryGraph({ catalog, questions, selectedQuestionId, topicId, sourceId, onSelectQuestion, onSelectTopic, onSelectSource, onOverview }: Props) {
  const [perspective, setPerspective] = useState<"questions" | "sources">("questions");
  const [authorId, setAuthorId] = useState("");
  const [pan, setPan] = useState({ x: 0, y: 0, zoom: 1 });
  const drag = useRef<{ id: number; x: number; y: number; originX: number; originY: number } | null>(null);
  const questionIds = useMemo(() => new Set(questions.map((question) => question.id)), [questions]);
  const sources = useMemo(() => questionIds.size === catalog.questions.length ? catalog.sources : catalog.sources.filter((source) => source.questionIds.some((id) => questionIds.has(id)) || questions.some((question) => question.sources.includes(source.id))), [catalog.sources, catalog.questions.length, questions, questionIds]);
  const groups: Group[] = useMemo(() => perspective === "questions"
    ? catalog.topics.map((topic) => ({ id: topic.id, label: topic.name, children: questions.filter((question) => question.topic === topic.id).map((question) => ({ id: question.id, label: question.title })) })).filter((topic) => topic.children.length)
    : catalog.authors.map((author) => ({ id: author.id, label: author.name, children: sources.filter((source) => source.authorId === author.id).map((source) => ({ id: source.id, label: source.title })) })).filter((author) => author.children.length), [catalog.topics, catalog.authors, perspective, questions, sources]);
  const source = catalog.sources.find((item) => item.id === sourceId);
  const topic = catalog.topics.find((item) => item.id === topicId);
  const author = perspective === "sources" ? groups.find((group) => group.id === authorId) : undefined;
  const focusTitle = source?.title ?? (perspective === "questions" ? topic?.name : author?.label);
  const focusKind = source ? "Source attribution" : perspective === "questions" ? "Topic" : "Author";
  const focusedItems = source || (perspective === "questions" && topic)
    ? questions.map((question) => ({ id: question.id, label: question.title }))
    : author?.children;
  const focusedSources = Boolean(author && !source);
  const editorialBridges = useMemo(() => {
    const questionTopics = new Map(catalog.questions.map((question) => [question.id, question.topic]));
    const seen = new Set<string>();
    return catalog.relationships.flatMap((edge) => {
      const from = questionTopics.get(edge.fromQuestionId);
      const to = questionTopics.get(edge.toQuestionId);
      if (!from || !to || from === to || !questionIds.has(edge.fromQuestionId) || !questionIds.has(edge.toQuestionId)) return [];
      const key = [from, to].sort().join(":");
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ from, to }];
    });
  }, [catalog.questions, catalog.relationships, questionIds]);
  function overview() { setAuthorId(""); setPan({ x: 0, y: 0, zoom: 1 }); onOverview(); }
  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.pointerType === "touch" && pan.zoom === 1) || (event.target as Element).closest("button, a")) return;
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, originX: pan.x, originY: pan.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  return <section className="interview-atlas" aria-label="Whole interview library graph">
    <header className="interview-atlas__header">
      <div><h2 data-typography="section-title">{focusTitle ?? (perspective === "questions" ? "Question map" : "Source map")}</h2><p className="muted">{focusTitle ? focusedItems?.length ? `${focusKind} · select a connected ${focusedSources ? "source" : "question"}` : "No linked questions in the current filters." : perspective === "questions" ? `${questions.length} questions across ${groups.length} topics` : `${sources.length} sources across ${groups.length} authors`}</p></div>
      <div className="interview-atlas__perspective" role="group" aria-label="Graph perspective">
        <Button size="sm" variant={perspective === "questions" ? "secondary" : "ghost"} aria-pressed={perspective === "questions"} onClick={() => { setPerspective("questions"); setAuthorId(""); }}>Questions</Button>
        <Button size="sm" variant={perspective === "sources" ? "secondary" : "ghost"} aria-pressed={perspective === "sources"} onClick={() => { setPerspective("sources"); setAuthorId(""); }}>Sources</Button>
      </div>
    </header>
    <div className={`interview-atlas__viewport${pan.zoom !== 1 ? " is-zoomed" : ""}`} role="group" aria-label="Interview graph canvas" tabIndex={0}
      onPointerDown={startDrag}
      onPointerMove={(event) => { const current = drag.current; if (current?.id === event.pointerId) setPan((previous) => ({ ...previous, x: current.originX + event.clientX - current.x, y: current.originY + event.clientY - current.y })); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        const offsets: Record<string, [number, number]> = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] };
        const offset = offsets[event.key];
        if (offset) { event.preventDefault(); setPan((previous) => ({ ...previous, x: previous.x + offset[0], y: previous.y + offset[1] })); }
        if (event.key === "Home" || event.key === "Escape") setPan({ x: 0, y: 0, zoom: 1 });
      }}>
      <div className="interview-atlas__world" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${pan.zoom})` }}>
        {focusTitle && focusedItems ? <div className="interview-atlas__branch">
          <div className="interview-atlas__branch-root"><span className={`interview-atlas__mark ${source || focusedSources ? "is-source" : ""}`} />{focusTitle}</div>
          <ul className="interview-atlas__branch-list">{focusedItems.map((item) => <li key={item.id}><Button variant="ghost" className="interview-atlas__named-node" aria-pressed={focusedSources ? sourceId === item.id : selectedQuestionId === item.id} onClick={() => focusedSources ? onSelectSource(item.id) : onSelectQuestion(item.id)}><span data-typography="metadata">{item.id}</span><span>{item.label}</span></Button></li>)}</ul>
        </div> : <div className="interview-atlas__clusters">
          {perspective === "questions" ? <svg className="interview-atlas__bridges" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
            {RESPONSIVE_LAYOUTS.map((layout) => <g key={layout.name} className={`interview-atlas__lines--${layout.name}`}>{editorialBridges.map((edge) => {
              const from = groups.findIndex((group) => group.id === edge.from); const to = groups.findIndex((group) => group.id === edge.to);
              if (from < 0 || to < 0) return null;
              const height = Math.ceil(groups.length / layout.columns) * layout.rowHeight;
              const point = (index: number) => ({ x: (index % layout.columns + .5) / layout.columns * 1000, y: (Math.floor(index / layout.columns) * layout.rowHeight + layout.center) / height * 1000 });
              const a = point(from); const b = point(to);
              return <path key={`${edge.from}:${edge.to}`} data-edge-kind="editorial" d={`M${a.x.toFixed(1)} ${a.y.toFixed(1)} Q${((a.x+b.x)/2).toFixed(1)} ${((a.y+b.y)/2-35).toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`} />;
            })}</g>)}
          </svg> : null}
          {groups.map((group) => { const positions = satellitePositions(group.children.length); return <div key={group.id} className="interview-atlas__cluster" data-selected={perspective === "questions" && group.children.some((item) => item.id === selectedQuestionId)}>
            <div className="interview-atlas__aura" aria-hidden="true" />
            <Button variant="ghost" className="interview-atlas__hub" aria-label={`${group.label}: ${group.children.length} ${perspective === "questions" ? "questions" : "sources"}`} onClick={() => { setPan({ x: 0, y: 0, zoom: 1 }); if (perspective === "questions") onSelectTopic(group.id); else setAuthorId(group.id); }}>
              <span className={`interview-atlas__mark ${perspective === "sources" ? "is-author" : ""}`} aria-hidden="true" /><span>{group.label}</span><small className="muted">{group.children.length} {perspective === "questions" ? "questions" : "sources"}</small>
            </Button>
            {group.children.map((item, index) => {
              const point = positions[index]!;
              return <Fragment key={item.id}><span className="interview-atlas__spoke" data-edge-kind={perspective === "sources" ? "source" : "topic"} aria-hidden="true" style={{ width: Math.hypot(point.x, point.y), transform: `rotate(${Math.atan2(point.y, point.x)}rad)` }} /><Button variant="ghost" size="icon" className={`interview-atlas__satellite${perspective === "sources" ? " is-source" : ""}`} data-graph-question-id={perspective === "questions" ? item.id : undefined} data-graph-source-id={perspective === "sources" ? item.id : undefined} aria-label={`${item.id}: ${item.label}`} aria-pressed={perspective === "questions" ? selectedQuestionId === item.id : sourceId === item.id} title={`${item.id}: ${item.label}`} style={{ left: `calc(50% + ${point.x.toFixed(1)}px)`, top: `${(90+point.y).toFixed(1)}px` }} onClick={() => perspective === "questions" ? onSelectQuestion(item.id) : onSelectSource(item.id)}><span className="interview-atlas__mark" aria-hidden="true" /></Button></Fragment>;
            })}
          </div>; })}
        </div>}
      </div>
      {!groups.length && !source ? <p className="interview-atlas__empty muted">No connections match these filters. Try Overview.</p> : null}
    </div>
    <footer className="interview-atlas__footer">
      <div className="interview-atlas__navigation"><Button size="icon" variant="outline" aria-label="Zoom out" disabled={pan.zoom <= .65} onClick={() => setPan((previous) => ({ ...previous, zoom: Math.max(.65, previous.zoom/1.2) }))}>−</Button><Button size="icon" variant="outline" aria-label="Zoom in" disabled={pan.zoom >= 2} onClick={() => setPan((previous) => ({ ...previous, zoom: Math.min(2, previous.zoom*1.2) }))}>+</Button><Button size="sm" variant="outline" onClick={overview}>Overview</Button><span className="muted" data-typography="metadata">{Math.round(pan.zoom*100)}%</span></div>
      <div className="interview-atlas__legend" aria-label="Graph legend"><span><i className="interview-atlas__mark" />Topic</span><span><i className="interview-atlas__mark is-question" />Question</span><span><i className="interview-atlas__mark is-source" />Source attribution</span><span><i className="interview-atlas__legend-edge" />Editorial bridge</span></div>
    </footer>
    <p className="interview-atlas__hint muted" data-typography="metadata">Select a topic or author to read its labels. Drag empty space or focus the canvas and use arrow keys to pan. <a href="#interview-question-title">Read selected question ↓</a></p>
  </section>;
}
