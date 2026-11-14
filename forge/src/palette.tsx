import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { Icon, type IconName } from "./icons";

export type Command = {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: IconName;
  keywords?: string;
  run: () => void;
};

/** 简易模糊匹配：查询的每个字符按顺序出现即可，连续命中加分。 */
function score(q: string, text: string): number {
  if (!q) return 1;
  const t = text.toLowerCase();
  if (t.includes(q)) return 100 - t.indexOf(q);
  let i = 0, s = 0, run = 0;
  for (const ch of t) {
    if (ch === q[i]) { i++; run++; s += run; } else run = 0;
    if (i === q.length) return s;
  }
  return 0;
}

export function CommandPalette(props: { commands: Command[]; onClose: () => void }) {
  const [q, setQ] = createSignal("");
  const [sel, setSel] = createSignal(0);
  let input!: HTMLInputElement;
  let list!: HTMLDivElement;

  const results = createMemo(() => {
    const query = q().trim().toLowerCase();
    return props.commands
      .map((c) => ({ c, s: score(query, `${c.label} ${c.group} ${c.keywords ?? ""}`) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => (query ? b.s - a.s : 0))
      .map((x) => x.c);
  });

  onMount(() => input.focus());

  const run = (c?: Command) => {
    if (!c) return;
    props.onClose();
    c.run();
  };

  const onKey = (e: KeyboardEvent) => {
    const n = results().length;
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => (s + 1) % Math.max(n, 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => (s - 1 + n) % Math.max(n, 1)); }
    else if (e.key === "Enter") { e.preventDefault(); run(results()[sel()]); }
    else if (e.key === "Escape") { e.preventDefault(); props.onClose(); }
    else return;
    list.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  };

  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="palette" onKeyDown={onKey}>
        <div class="palette-in">
          <Icon name="search" />
          <input
            ref={input}
            placeholder="搜索命令、项目、功能…"
            value={q()}
            onInput={(e) => { setQ(e.currentTarget.value); setSel(0); }}
          />
          <kbd>Esc</kbd>
        </div>
        <div class="palette-list" ref={list}>
          <Show when={results().length} fallback={<div class="empty" style={{ padding: "36px" }}>没有匹配的命令</div>}>
            <For each={results()}>
              {(c, i) => (
                <>
                  <Show when={!q() && (i() === 0 || results()[i() - 1].group !== c.group)}>
                    <div class="pgroup">{c.group}</div>
                  </Show>
                  <button
                    class="pcmd"
                    classList={{ sel: i() === sel() }}
                    onMouseMove={() => setSel(i())}
                    onClick={() => run(c)}
                  >
                    <Icon name={c.icon} size={16} />
                    <span class="lbl">{c.label}</span>
                    <Show when={c.hint}><span class="hint">{c.hint}</span></Show>
                  </button>
                </>
              )}
            </For>
          </Show>
        </div>
        <div class="palette-foot">
          <span><kbd>↑</kbd> <kbd>↓</kbd> 选择</span>
          <span><kbd>Enter</kbd> 执行</span>
          <span style={{ "margin-left": "auto" }}>Forge 命令面板</span>
        </div>
      </div>
    </div>
  );
}
