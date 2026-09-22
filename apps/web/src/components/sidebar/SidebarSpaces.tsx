import { projectSpaceForKeys } from "@t3tools/client-runtime/state/project-grouping";
import type { ProjectSpace } from "@t3tools/contracts";
import { Layers3Icon, LayoutGridIcon, MoreHorizontalIcon, PlusIcon, XIcon } from "lucide-react";
import type { DragEvent } from "react";

import { cn } from "../../lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/menu";

export function SidebarSpaces(props: {
  spaces: ReadonlyArray<ProjectSpace>;
  projects: ReadonlyArray<SidebarProjectSnapshot>;
  activeSpaceId: string | null;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onSelect: (spaceId: string | null) => void;
  onAssign: (project: SidebarProjectSnapshot, spaceId: string | null) => void;
  onCreate: () => void;
  onRename: (space: ProjectSpace) => void;
  onDelete: (space: ProjectSpace) => void;
}) {
  const selectSpace = (spaceId: string | null) => {
    props.onSelect(spaceId);
    if (props.expanded) props.onExpandedChange(false);
  };

  return (
    <>
      <nav
        aria-label="Spaces"
        className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto px-3"
      >
        <button
          type="button"
          aria-label="All spaces"
          aria-current={props.activeSpaceId === null ? "page" : undefined}
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md text-sidebar-muted-foreground outline-none transition-[background-color,color,transform] duration-150 ease-out hover:bg-sidebar-row-hover hover:text-sidebar-foreground active:scale-95 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring",
            props.activeSpaceId === null && "bg-sidebar-row-active text-sidebar-foreground",
          )}
          onClick={() => selectSpace(null)}
        >
          <Layers3Icon className="size-4" />
        </button>

        {props.spaces.map((space) => {
          const active = space.id === props.activeSpaceId;
          return (
            <div
              key={space.id}
              className={cn(
                "flex h-7 shrink-0 items-center rounded-md transition-colors duration-150 motion-reduce:transition-none",
                active && "bg-sidebar-row-active text-sidebar-foreground",
              )}
            >
              <button
                type="button"
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-sidebar-muted-foreground outline-none transition-[color,transform] duration-150 ease-out hover:bg-sidebar-row-hover hover:text-sidebar-foreground active:scale-[0.97] motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring",
                  active && "text-sidebar-foreground",
                )}
                onClick={() => selectSpace(space.id)}
              >
                <span aria-hidden className="flex size-4 items-center justify-center uppercase">
                  {Array.from(space.name)[0]}
                </span>
                <span className="max-w-24 truncate">{space.name}</span>
              </button>
              {active ? (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label={`Manage ${space.name} space`}
                    className="mr-0.5 flex size-6 items-center justify-center rounded text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <MoreHorizontalIcon className="size-3.5" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem onClick={() => props.onRename(space)}>
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onClick={() => props.onDelete(space)}>
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          );
        })}

        <button
          type="button"
          aria-label="Create space"
          className="flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-sidebar-muted-foreground outline-none transition-transform duration-150 ease-out hover:bg-sidebar-row-hover hover:text-sidebar-foreground active:scale-95 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={props.onCreate}
        >
          <PlusIcon className="size-3.5" />
          {props.spaces.length === 0 ? "Space" : null}
        </button>
        <button
          type="button"
          aria-label="Manage spaces"
          aria-expanded={props.expanded}
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md text-sidebar-muted-foreground outline-none transition-[background-color,color,transform] duration-150 ease-out hover:bg-sidebar-row-hover hover:text-sidebar-foreground active:scale-95 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring",
            props.expanded && "bg-sidebar-row-active text-sidebar-foreground",
          )}
          onClick={() => props.onExpandedChange(!props.expanded)}
        >
          <LayoutGridIcon className="size-3.5" />
        </button>
      </nav>

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
          <div className="flex min-h-0 flex-1 gap-4 overflow-x-auto pb-2">
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
                          <DropdownMenuItem onClick={() => props.onRename(space)}>
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
                          className="flex cursor-grab flex-col gap-2 rounded-xl bg-background/80 p-2 shadow-xs transition-[transform,opacity] duration-150 ease-out active:scale-[0.98] active:cursor-grabbing motion-reduce:transition-none"
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
                          <select
                            aria-label={`Move ${project.displayName}`}
                            className="w-full rounded-md border bg-background px-1 py-0.5 text-xs text-muted-foreground"
                            value={spaceId ?? "unassigned"}
                            onChange={(event) =>
                              props.onAssign(
                                project,
                                event.target.value === "unassigned" ? null : event.target.value,
                              )
                            }
                          >
                            <option value="unassigned">Unassigned</option>
                            {props.spaces.map((entry) => (
                              <option key={entry.id} value={entry.id}>
                                {entry.name}
                              </option>
                            ))}
                          </select>
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
              onClick={props.onCreate}
            >
              <PlusIcon className="size-5" />
              New Space
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
