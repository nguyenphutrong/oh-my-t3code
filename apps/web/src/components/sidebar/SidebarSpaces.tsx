import type { ProjectSpace } from "@t3tools/contracts";
import { Layers3Icon, MoreHorizontalIcon, PlusIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/menu";

export function SidebarSpaces(props: {
  spaces: ReadonlyArray<ProjectSpace>;
  activeSpaceId: string | null;
  onSelect: (spaceId: string | null) => void;
  onCreate: () => void;
  onRename: (space: ProjectSpace) => void;
  onDelete: (space: ProjectSpace) => void;
}) {
  return (
    <nav aria-label="Spaces" className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto px-3">
      <button
        type="button"
        aria-label="All spaces"
        aria-current={props.activeSpaceId === null ? "page" : undefined}
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring",
          props.activeSpaceId === null && "bg-sidebar-row-active text-sidebar-foreground",
        )}
        onClick={() => props.onSelect(null)}
      >
        <Layers3Icon className="size-4" />
      </button>

      {props.spaces.map((space) => {
        const active = space.id === props.activeSpaceId;
        return (
          <div
            key={space.id}
            className={cn(
              "flex h-7 shrink-0 items-center rounded-md",
              active && "bg-sidebar-row-active text-sidebar-foreground",
            )}
          >
            <button
              type="button"
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring",
                active && "text-sidebar-foreground",
              )}
              onClick={() => props.onSelect(space.id)}
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
                  <DropdownMenuItem onClick={() => props.onRename(space)}>Rename</DropdownMenuItem>
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
        className="flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={props.onCreate}
      >
        <PlusIcon className="size-3.5" />
        {props.spaces.length === 0 ? "Space" : null}
      </button>
    </nav>
  );
}
