import { Link } from "wouter";
import ModelEvidence from "@/components/ModelEvidence";

export default function ModelEvidencePage() {
  return <main className="evidence-page"><Link href="/">← Back to dashboard</Link><h1>Model evidence</h1><ModelEvidence standalone /></main>;
}
