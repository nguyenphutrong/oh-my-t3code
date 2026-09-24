import { projectSpaceForKeys } from "@t3tools/client-runtime/state/project-grouping";
import type { ProjectSpace } from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  Layers3Icon,
  LayoutGridIcon,
  MoreHorizontalIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { useState, type DragEvent } from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { cn } from "../../lib/utils";
import { usePanelPresence } from "../../panelAnimations";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";

const spaceDotColors = ["bg-orange-500", "bg-sky-500", "bg-emerald-500", "bg-violet-500"];

export function SidebarSpaces(props: {
  spaces: ReadonlyArray<ProjectSpace>;
  projects: ReadonlyArray<SidebarProjectSnapshot>;
  activeSpaceId: string | null;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onSelect: (spaceId: string | null) => void;
  onAssign: (project: SidebarProjectSnapshot, spaceId: string | null) => void;
  onCreate: (name: string) => void;
  onRename: (space: ProjectSpace, name: string) => void;
  onDelete: (space: ProjectSpace) => void;
}) {
  const [editor, setEditor] = useState<{ space: ProjectSpace | null; name: string } | null>(null);
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const editorPresence = usePanelPresence(
    editor !== null,
    editor,
    !prefersReducedMotion,
    "space-editor",
    200,
  );
  const renderedEditor = editorPresence.value;
  const activeSpace = props.spaces.find((space) => space.id === props.activeSpaceId) ?? null;
  const selectSpace = (spaceId: string | null) => {
    props.onSelect(spaceId);
    if (props.expanded) props.onExpandedChange(false);
  };

  return (
    <>
      <nav
        aria-label="Spaces"
        className="relative z-10 -mt-[var(--workspace-topbar-height)] flex h-[var(--workspace-topbar-height)] shrink-0 items-start pt-1 pl-[calc(var(--workspace-titlebar-content-left)-0.75rem)] pr-3"
      >
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Switch space"
            className="-translate-y-px flex h-7 max-w-full items-center gap-2 rounded-md bg-sidebar-row-hover px-2 text-sm font-semibold text-sidebar-foreground outline-none transition-colors [-webkit-app-region:no-drag] hover:bg-sidebar-row-active focus-visible:ring-2 focus-visible:ring-ring"
          >
            {activeSpace ? (
              <span
                aria-hidden
                className={cn(
                  "size-2.5 shrink-0 rounded-full",
                  spaceDotColors[props.spaces.indexOf(activeSpace) % spaceDotColors.length],
                )}
              />
            ) : (
              <Layers3Icon className="size-4 shrink-0 text-sidebar-muted-foreground" />
            )}
            <span className="min-w-0 truncate">{activeSpace?.name ?? "All Spaces"}</span>
            <ChevronDownIcon className="ml-auto size-3.5 shrink-0 text-sidebar-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={6} className="w-56">
            <DropdownMenuItem onClick={() => selectSpace(null)}>
              <CheckIcon className={cn("size-4", props.activeSpaceId !== null && "opacity-0")} />
              <Layers3Icon className="size-4 text-muted-foreground" />
              All Spaces
            </DropdownMenuItem>
            {props.spaces.map((space, index) => (
              <DropdownMenuItem key={space.id} onClick={() => selectSpace(space.id)}>
                <CheckIcon
                  className={cn("size-4", space.id !== props.activeSpaceId && "opacity-0")}
                />
                <span
                  aria-hidden
                  className={cn(
                    "size-2.5 shrink-0 rounded-full",
                    spaceDotColors[index % spaceDotColors.length],
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{space.name}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setEditor({ space: null, name: "" })}>
              <PlusIcon className="size-4" />
              New Space…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => props.onExpandedChange(true)}>
              <LayoutGridIcon className="size-4" />
              Manage Spaces
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </nav>

      {editorPresence.present && renderedEditor ? (
        <div
          className={cn(
            "grid shrink-0 overflow-hidden",
            editor
              ? "translate-y-0 grid-rows-[1fr] opacity-100"
              : "-translate-y-1 grid-rows-[0fr] opacity-0",
            "transition-[grid-template-rows,opacity,transform] duration-200 ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none",
            editor &&
              "starting:-translate-y-1 starting:grid-rows-[0fr] starting:opacity-0 motion-reduce:starting:translate-y-0 motion-reduce:starting:grid-rows-[1fr] motion-reduce:starting:opacity-100",
          )}
        >
          <div
            className="min-h-0 overflow-hidden"
            aria-hidden={editor === null}
            inert={editor === null}
          >
            <form
              className="mx-3 mb-2 flex items-center gap-1 rounded-xl bg-sidebar-row-active p-1 shadow-sm ring-1 ring-sidebar-border/70"
              onSubmit={(event) => {
                event.preventDefault();
                const name = renderedEditor.name.trim();
                if (!name) return;
                if (renderedEditor.space) props.onRename(renderedEditor.space, name);
                else props.onCreate(name);
                setEditor(null);
              }}
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-background/70 text-xs font-semibold text-sidebar-muted-foreground">
                {renderedEditor.space ? (
                  Array.from(renderedEditor.space.name)[0]
                ) : (
                  <PlusIcon className="size-3.5" />
                )}
              </span>
              <input
                autoFocus
                aria-label={renderedEditor.space ? "Rename space" : "Space name"}
                className="h-8 min-w-0 flex-1 bg-transparent px-1.5 text-sm outline-none placeholder:text-sidebar-muted-foreground/60"
                placeholder="Space name…"
                value={renderedEditor.name}
                onChange={(event) => setEditor({ ...renderedEditor, name: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setEditor(null);
                }}
              />
              <button
                type="submit"
                aria-label={renderedEditor.space ? "Save space name" : "Create space"}
                className="flex size-7 items-center justify-center rounded-lg bg-sidebar-foreground text-sidebar disabled:opacity-30"
                disabled={!renderedEditor.name.trim()}
              >
                <CheckIcon className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label="Cancel editing space"
                className="flex size-7 items-center justify-center rounded-lg text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                onClick={() => setEditor(null)}
              >
                <XIcon className="size-3.5" />
              </button>
            </form>
          </div>
        </div>
      ) : null}

      {props.expanded ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-4 pt-2">
          <header className="flex shrink-0 items-start justify-between gap-4 px-1 pb-4">
            <div>
              <h2 className="font-heading text-lg font-semibold">Spaces</h2>
              <p className="text-sm text-sidebar-muted-foreground">
                Organize projects into focused workspaces. Drag a project or use its selector.
              </p>
            </div>
            <button
              type="button"
              aria-label="Close spaces"
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => props.onExpandedChange(false)}
            >
              <XIcon className="size-4" />
            </button>
          </header>
          <ScrollArea
            className="min-h-0 flex-1 [&>[data-orientation=vertical]]:hidden"
            radius="none"
          >
            <div className="flex h-full min-w-max gap-4 pb-3 pr-4">
              {[null, ...props.spaces].map((space) => {
                const spaceId = space?.id ?? null;
                const projects = props.projects.filter((project) => {
                  const assigned = projectSpaceForKeys(
                    props.spaces,
                    project.memberProjects.map((member) => member.physicalProjectKey),
                  );
                  return (assigned?.id ?? null) === spaceId;
                });
                return (
                  <section
                    key={spaceId ?? "unassigned"}
                    className={cn(
                      "flex h-full min-h-72 w-1/4 min-w-48 max-w-64 shrink-0 flex-col rounded-2xl border border-sidebar-border bg-sidebar-row-hover/50 p-3 shadow-sm transition-[transform,box-shadow,border-color] duration-200 ease-[cubic-bezier(.2,.8,.2,1)] hover:-translate-y-0.5 hover:shadow-md motion-reduce:transition-none",
                      spaceId !== null &&
                        spaceId === props.activeSpaceId &&
                        "border-primary/40 bg-primary/5",
                    )}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      const project = props.projects.find(
                        (entry) => entry.projectKey === event.dataTransfer.getData("text/plain"),
                      );
                      if (project) props.onAssign(project, spaceId);
                    }}
                  >
                    <div className="mb-3 flex h-8 items-center gap-2 px-1">
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left font-heading font-semibold"
                        onClick={() => {
                          selectSpace(spaceId);
                        }}
                      >
                        {space?.name ?? "Unassigned"}
                      </button>
                      {space ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            aria-label={`Manage ${space.name} space`}
                            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                          >
                            <MoreHorizontalIcon className="size-4" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() => setEditor({ space, name: space.name })}
                            >
                              Rename
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() => props.onDelete(space)}
                            >
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </div>

                    <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
                      {projects.length === 0 ? (
                        <p className="px-2 py-8 text-center text-sm text-muted-foreground">
                          Drop projects here
                        </p>
                      ) : (
                        projects.map((project) => (
                          <div
                            key={project.projectKey}
                            draggable
                            className="cursor-grab rounded-xl bg-background/80 p-2 shadow-xs transition-[transform,opacity] duration-150 ease-out active:scale-[0.98] active:cursor-grabbing motion-reduce:transition-none"
                            onDragStart={(event: DragEvent<HTMLDivElement>) => {
                              event.dataTransfer.effectAllowed = "move";
                              event.dataTransfer.setData("text/plain", project.projectKey);
                            }}
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              <ProjectFavicon project={project} className="size-4 shrink-0" />
                              <span className="min-w-0 flex-1 truncate text-sm">
                                {project.displayName}
                              </span>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </section>
                );
              })}

              <button
                type="button"
                className="flex h-full min-h-72 w-48 shrink-0 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-sidebar-border text-sm text-sidebar-muted-foreground transition-[transform,border-color,color] duration-200 hover:-translate-y-0.5 hover:border-sidebar-foreground/30 hover:text-sidebar-foreground motion-reduce:transition-none"
                onClick={() => setEditor({ space: null, name: "" })}
              >
                <PlusIcon className="size-5" />
                New Space
              </button>
            </div>
          </ScrollArea>
        </div>
      ) : null}
    </>
  );
}

export function SidebarSpaceIndicators(props: {
  spaces: ReadonlyArray<ProjectSpace>;
  activeSpaceId: string | null;
  onSelect: (spaceId: string) => void;
}) {
  if (props.spaces.length < 2) return null;

  return (
    <nav
      aria-label="Space shortcuts"
      className="flex h-7 shrink-0 items-center justify-center gap-1"
    >
      {props.spaces.map((space, index) => (
        <button
          key={space.id}
          type="button"
          aria-label={`Switch to ${space.name}`}
          aria-current={space.id === props.activeSpaceId ? "page" : undefined}
          className="flex size-5 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => props.onSelect(space.id)}
        >
          <span
            aria-hidden
            className={cn(
              "size-2 rounded-full transition-[transform,opacity]",
              spaceDotColors[index % spaceDotColors.length],
              space.id === props.activeSpaceId ? "scale-110 opacity-100" : "opacity-35",
            )}
          />
        </button>
      ))}
    </nav>
  );
}
