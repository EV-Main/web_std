import { useState } from "react";
import { Button, Hotbar, StatusItem, Switch, useBinding, type HotbarAction } from "@evinvest/uikit";
import { Block, Caption, PageRoot } from "../../gallery/ui";
import { BotIcon, CheckIcon, FileTextIcon, MapPinIcon, PencilIcon, SearchIcon, TargetIcon } from "../../gallery/icons";

export default function HotbarPage() {
  const [agent, setAgent] = useState(false);
  const [places, setPlaces] = useState(true);
  const [urgent, setUrgent] = useState(false);
  const [last, setLast] = useState("nothing yet");
  const run = (label: string) => () => setLast(label);
  const actions: HotbarAction[] = [
    { id: "next-lead", label: "Next lead", icon: TargetIcon, binding: "next-lead", onSelect: run("Next lead") },
    { id: "log-outcome", label: "Log outcome", icon: CheckIcon, binding: "log-outcome", onSelect: run("Log outcome") },
    { id: "search", label: "Search", icon: SearchIcon, onSelect: run("Search") },
    { id: "agent", label: "Agent", icon: BotIcon, binding: "agent", pressed: agent, onSelect: () => setAgent((on) => !on) },
    { id: "places", label: "Places", icon: MapPinIcon, binding: "places", pressed: places, onSelect: () => setPlaces((on) => !on) },
    { id: "add-note", label: "Add note", icon: PencilIcon, pinned: false, onSelect: run("Add note") },
    { id: "export", label: "Export leads (CSV)", icon: FileTextIcon, pinned: false, onSelect: run("Export leads") },
  ];
  const bind = (key: string, { id, label, onSelect }: HotbarAction) => ({ on: { key }, run: { id, label, run: onSelect } });
  useBinding(bind("n", actions[0]!));
  useBinding(bind("o", actions[1]!));
  useBinding(bind("a", actions[3]!));
  useBinding(bind("p", actions[4]!));
  const status = (
    <>
      <StatusItem tone={agent ? "positive" : "muted"}>{agent ? "Agent connected" : "Agent off"}</StatusItem>
      <StatusItem value="1,240">Tokens</StatusItem>
      <StatusItem tone="muted" value="12s ago">
        Synced
      </StatusItem>
    </>
  );
  const takeover = urgent
    ? {
        tone: "error" as const,
        message: "Urgent lead: Hendricks Plumbing asked for a call-back in 10 min",
        action: (
          <Button size="xs" variant="outline" onClick={() => setUrgent(false)}>
            Call now
          </Button>
        ),
      }
    : undefined;
  return (
    <PageRoot
      title="Hotbar"
      lede="The strip a terminal-style app docks at the bottom of the viewport: pinned actions with the keys that run them too, a customize popover, live status at the end. Agent and Places are toggles the app owns; the bar only shows them pressed."
    >
      <Block title="Wide" note={`Alt+S then N, O, A or P (⌥S on macOS), outside a field. Last action: ${last}.`}>
        <div className="flex flex-col gap-3">
          <label className="flex items-center gap-2 self-start text-body text-ink-mid">
            <Switch checked={urgent} onCheckedChange={setUrgent} />
            Urgent takeover
          </label>
          <div className="overflow-x-auto">
            <div className="min-w-[1100px]">
              <Hotbar actions={actions} status={status} takeover={takeover} />
            </div>
          </div>
        </div>
      </Block>
      <Block title="Narrow">
        <div className="flex flex-col gap-2">
          <Caption>Under a 64rem strip: a sideways-scrolling chip row, no shortcuts shown, no status.</Caption>
          <div className="w-[390px] max-w-full">
            <Hotbar actions={actions} status={status} takeover={takeover} />
          </div>
        </div>
      </Block>
    </PageRoot>
  );
}
