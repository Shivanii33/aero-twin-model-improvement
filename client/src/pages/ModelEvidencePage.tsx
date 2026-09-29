import { Link } from "wouter";
import ModelEvidence from "@/components/ModelEvidence";
import { useDemoAuth } from "@/lib/demoAuth";
import { RoleSection } from "@/components/RoleAccess";

export default function ModelEvidencePage() {
  const { user } = useDemoAuth();
  return <main className="evidence-page"><Link href="/">← Back to dashboard</Link><h1>Model evidence</h1><RoleSection role={user.role} required="Maintenance Engineer"><ModelEvidence standalone /></RoleSection></main>;
}
