import {
  BookOpen,
  FileText,
  Globe2,
  Image,
  Layers,
  Smartphone,
  Video,
  Workflow,
} from "lucide-react";
import {
  AppResult,
  StudyResult,
  VideoResult,
  WebsiteResult,
} from "./PreviewResults";
import {
  AutomationPreview,
  DesignPreview,
  DocumentPreview,
  ExplorePreview,
} from "./InterestVisuals";
import content from "./content.json";

const visuals = {
  websites: { Icon: Globe2, Preview: WebsiteResult },
  apps: { Icon: Smartphone, Preview: AppResult },
  videos: { Icon: Video, Preview: VideoResult },
  design: { Icon: Image, Preview: DesignPreview },
  study: { Icon: BookOpen, Preview: StudyResult },
  automations: { Icon: Workflow, Preview: AutomationPreview },
  writing: { Icon: FileText, Preview: DocumentPreview },
  exploring: { Icon: Layers, Preview: ExplorePreview },
};

export const interests = content.interests.map((interest) => ({
  ...interest,
  ...visuals[interest.id as keyof typeof visuals],
}));
