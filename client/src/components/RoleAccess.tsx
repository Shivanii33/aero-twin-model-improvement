import { useId, type ReactNode } from "react";
import { LockKeyhole } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { DemoRole } from "@/lib/demoAuth";

export function roleReason(required: DemoRole) {
  return required === "Operator" ? "Only Operator can do this" : "Only Engineer can do this";
}

export function RoleControl({ role, required, children }: { role: DemoRole; required: DemoRole; children: ReactNode }) {
  const reasonId = useId();
  if (role === required) return <>{children}</>;
  return <Tooltip>
    <TooltipTrigger asChild>
      <span className="role-control" tabIndex={0} aria-disabled="true" aria-describedby={reasonId}>
        {children}
        <span className="sr-only" id={reasonId}>{roleReason(required)}</span>
      </span>
    </TooltipTrigger>
    <TooltipContent>{roleReason(required)}</TooltipContent>
  </Tooltip>;
}

export function RoleNotice({ role, required }: { role: DemoRole; required: DemoRole }) {
  const reasonId = useId();
  if (role === required) return null;
  return <Tooltip><TooltipTrigger asChild><span className="role-section-notice" tabIndex={0} aria-disabled="true" aria-describedby={reasonId}><LockKeyhole size={14} aria-hidden="true" /><span id={reasonId}>{roleReason(required)} · Sign in as {required === "Operator" ? "Operator" : "Engineer"}.</span></span></TooltipTrigger><TooltipContent>{roleReason(required)}</TooltipContent></Tooltip>;
}

export function RoleSection({ role, required, children, className = "" }: { role: DemoRole; required: DemoRole; children: ReactNode; className?: string }) {
  const locked = role !== required;
  return <div className={`role-section ${locked ? "role-section-locked" : ""} ${className}`}>
    <RoleNotice role={role} required={required} />
    <div inert={locked ? true : undefined} className={locked ? "role-section-content" : undefined}>{children}</div>
  </div>;
}
