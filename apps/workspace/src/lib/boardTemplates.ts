import type { Column, ColumnType, StatusColor } from "./types";

export type TemplateCategory = "Personal" | "Study" | "Product & Engineering" | "Business" | "Start from scratch";

export interface TemplateColumn {
  name: string;
  type: ColumnType;
  hidden?: boolean;
  options?: Array<{ label: string; color?: StatusColor }>;
}

export interface BoardTemplate {
  id: string;
  name: string;
  category: TemplateCategory;
  description: string;
  icon: string;
  columns: TemplateColumn[];
  defaultView: "table" | "board";
  /** Example values keyed by property name, for the preview only. */
  sampleRows: Array<Record<string, string>>;
}

const status = (name: string, labels: string[]): TemplateColumn => ({
  name,
  type: "status",
  options: labels.map((label) => ({ label })),
});

const select = (name: string, labels: string[]): TemplateColumn => ({
  name,
  type: "select",
  options: labels.map((label) => ({ label })),
});

const field = (name: string, type: ColumnType): TemplateColumn => ({ name, type });

export const BOARD_TEMPLATES: BoardTemplate[] = [
  {
    id: "simple-todo",
    name: "Simple to-do",
    category: "Personal",
    description: "The shortest path from a thought to a finished task.",
    icon: "list",
    defaultView: "table",
    columns: [field("Completed", "checkbox"), field("Due", "date")],
    sampleRows: [
      { Task: "Finish the assignment", Completed: "No", Due: "Tomorrow" },
      { Task: "Study chapter 4", Completed: "Yes", Due: "Friday" },
    ],
  },
  {
    id: "personal-tasks",
    name: "Personal tasks",
    category: "Personal",
    description: "A light task list with status, due dates and priorities.",
    icon: "check",
    defaultView: "table",
    columns: [
      status("Status", ["To do", "Doing", "Done"]),
      field("Due", "date"),
      select("Priority", ["Low", "Medium", "High"]),
    ],
    sampleRows: [
      { Task: "Book dentist", Status: "To do", Due: "Mon", Priority: "High" },
      { Task: "Renew passport", Status: "Doing", Due: "Next week", Priority: "Medium" },
    ],
  },
  {
    id: "weekly-planner",
    name: "Weekly planner",
    category: "Personal",
    description: "Plan the week by day, with a focus and a done checkbox.",
    icon: "calendar",
    defaultView: "table",
    columns: [
      select("Day", ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
      field("Focus", "text"),
      field("Done", "checkbox"),
    ],
    sampleRows: [
      { Task: "Gym", Day: "Monday", Focus: "Leg day", Done: "No" },
      { Task: "Deep work block", Day: "Tuesday", Focus: "Write proposal", Done: "No" },
    ],
  },
  {
    id: "habit-tracker",
    name: "Habit tracker",
    category: "Personal",
    description: "Build a streak with a simple daily check-in.",
    icon: "sparkles",
    defaultView: "table",
    columns: [
      field("Done", "checkbox"),
      field("Streak", "number"),
      field("Date", "date"),
    ],
    sampleRows: [
      { Task: "Read 20 pages", Done: "Yes", Streak: "12", Date: "Today" },
      { Task: "Walk", Done: "No", Streak: "4", Date: "Today" },
    ],
  },
  {
    id: "assignment-tracker",
    name: "Assignment tracker",
    category: "Study",
    description: "Track assignments, deadlines and progress across your courses.",
    icon: "graduation",
    defaultView: "table",
    columns: [
      select("Course", ["Computer Science", "Mathematics", "Economics"]),
      status("Status", ["Not started", "Working on it", "Submitted", "Done"]),
      field("Due date", "date"),
      select("Priority", ["Low", "Medium", "High"]),
    ],
    sampleRows: [
      { Task: "Problem set 3", Course: "Mathematics", Status: "Working on it", "Due date": "Friday", Priority: "High" },
      { Task: "Essay draft", Course: "Economics", Status: "Not started", "Due date": "Next week", Priority: "Medium" },
    ],
  },
  {
    id: "study-planner",
    name: "Study planner",
    category: "Study",
    description: "Plan study sessions by subject and date.",
    icon: "book",
    defaultView: "table",
    columns: [
      select("Subject", ["Math", "Science", "History", "Language"]),
      field("Study date", "date"),
      field("Minutes", "number"),
      field("Done", "checkbox"),
    ],
    sampleRows: [
      { Task: "Review calculus", Subject: "Math", "Study date": "Tuesday", Minutes: "45", Done: "No" },
      { Task: "Read chapter 2", Subject: "History", "Study date": "Thursday", Minutes: "30", Done: "No" },
    ],
  },
  {
    id: "course-planner",
    name: "Course planner",
    category: "Study",
    description: "Keep every course, instructor and credit in one place.",
    icon: "layers",
    defaultView: "table",
    columns: [
      field("Instructor", "text"),
      field("Schedule", "text"),
      field("Credits", "number"),
      field("Notes", "longtext"),
    ],
    sampleRows: [
      { Task: "Introduction to Economics", Instructor: "Dr. Cohen", Schedule: "Mon/Wed", Credits: "3", Notes: "" },
    ],
  },
  {
    id: "exam-prep",
    name: "Exam preparation",
    category: "Study",
    description: "Plan revision, track confidence and keep exam dates visible.",
    icon: "target",
    defaultView: "table",
    columns: [
      select("Subject", ["Math", "Science", "History"]),
      field("Exam date", "date"),
      field("Confidence", "progress"),
      status("Status", ["Not started", "Studying", "Ready for exam", "Completed"]),
    ],
    sampleRows: [
      { Task: "Algebra revision", Subject: "Math", "Exam date": "Jun 18", Confidence: "65", Status: "Studying" },
    ],
  },
  {
    id: "product-roadmap",
    name: "Product roadmap",
    category: "Product & Engineering",
    description: "Shape the product story from discovery to release.",
    icon: "rocket",
    defaultView: "board",
    columns: [
      status("Status", ["Backlog", "Discovery", "Planned", "In progress", "Review", "Released"]),
      field("Assignee", "person"),
      select("Priority", ["Low", "Medium", "High", "Critical"]),
      field("Timeline", "daterange"),
      field("Progress", "progress"),
      select("Area", ["Core", "Growth", "Platform", "Mobile"]),
      {
        name: "Tags",
        type: "multiselect",
        options: ["Design", "Frontend", "Backend", "Mobile"].map((label) => ({ label })),
      },
    ],
    sampleRows: [
      { Task: "Onboarding redesign", Status: "In progress", Assignee: "Maya", Priority: "High", Timeline: "Jun 3 – Jun 21", Progress: "60", Area: "Growth", Tags: "Design, Mobile" },
      { Task: "Billing v2", Status: "Discovery", Assignee: "Liam", Priority: "Critical", Timeline: "Jul 1 – Aug 2", Progress: "15", Area: "Core", Tags: "Backend" },
    ],
  },
  {
    id: "sprint-board",
    name: "Sprint board",
    category: "Product & Engineering",
    description: "A focused sprint with points, owners and a kanban flow.",
    icon: "columns",
    defaultView: "board",
    columns: [
      status("Status", ["Backlog", "To do", "In progress", "Review", "Done"]),
      field("Assignee", "person"),
      select("Priority", ["Low", "Medium", "High"]),
      field("Points", "number"),
    ],
    sampleRows: [
      { Task: "Login bug", Status: "In progress", Assignee: "Maya", Priority: "High", Points: "3" },
      { Task: "Empty states", Status: "To do", Assignee: "Noah", Priority: "Medium", Points: "2" },
    ],
  },
  {
    id: "feature-tracker",
    name: "Feature tracker",
    category: "Product & Engineering",
    description: "Track feature ideas, owners and delivery progress.",
    icon: "star",
    defaultView: "table",
    columns: [
      status("Status", ["Idea", "Planned", "Building", "Shipped"]),
      select("Priority", ["Low", "Medium", "High"]),
      field("Owner", "person"),
      field("Progress", "progress"),
      field("Release", "date"),
    ],
    sampleRows: [
      { Task: "Saved views", Status: "Building", Priority: "High", Owner: "Maya", Progress: "70", Release: "Jun 30" },
    ],
  },
  {
    id: "bug-tracker",
    name: "Bug tracker",
    category: "Product & Engineering",
    description: "Triage bugs by severity, status and reporter.",
    icon: "bug",
    defaultView: "table",
    columns: [
      status("Status", ["New", "Triaged", "In progress", "Fixed", "Closed"]),
      select("Severity", ["Low", "Medium", "High", "Critical"]),
      field("Reporter", "person"),
      field("Reported", "date"),
    ],
    sampleRows: [
      { Task: "Save button is unresponsive", Status: "Triaged", Severity: "Critical", Reporter: "Noah", Reported: "Today" },
    ],
  },
  {
    id: "project-tracker",
    name: "Project tracker",
    category: "Business",
    description: "Keep projects, owners, budgets and progress together.",
    icon: "briefcase",
    defaultView: "table",
    columns: [
      status("Status", ["Not started", "In progress", "Blocked", "Done"]),
      field("Owner", "person"),
      field("Due", "date"),
      field("Budget", "number"),
      field("Progress", "progress"),
    ],
    sampleRows: [
      { Task: "Website refresh", Status: "In progress", Owner: "Maya", Due: "Jul 15", Budget: "12000", Progress: "45" },
      { Task: "Office move", Status: "Not started", Owner: "Liam", Due: "Sep 1", Budget: "8000", Progress: "0" },
    ],
  },
  {
    id: "crm",
    name: "CRM / Leads",
    category: "Business",
    description: "Follow leads from first contact to a closed deal.",
    icon: "users",
    defaultView: "board",
    columns: [
      status("Stage", ["New lead", "Contacted", "Demo", "Negotiation", "Won", "Lost"]),
      field("Contact", "text"),
      field("Owner", "person"),
      field("Value", "number"),
      field("Next follow-up", "date"),
      field("Notes", "longtext"),
    ],
    sampleRows: [
      { Task: "Acme Corp", Stage: "Demo", Contact: "Dana", Owner: "Maya", Value: "24000", "Next follow-up": "Thursday", Notes: "Wants SSO" },
      { Task: "Northwind", Stage: "Contacted", Contact: "Sam", Owner: "Liam", Value: "8000", "Next follow-up": "Friday", Notes: "" },
    ],
  },
  {
    id: "hiring-pipeline",
    name: "Hiring pipeline",
    category: "Business",
    description: "Move candidates through a clear hiring process.",
    icon: "user",
    defaultView: "board",
    columns: [
      status("Stage", ["Applied", "Screening", "Interview", "Offer", "Hired", "Rejected"]),
      select("Role", ["Design", "Engineering", "Marketing", "Operations"]),
      field("Applied", "date"),
      field("Rating", "progress"),
    ],
    sampleRows: [
      { Task: "Noa Levi", Stage: "Interview", Role: "Design", Applied: "May 28", Rating: "80" },
    ],
  },
  {
    id: "content-calendar",
    name: "Content calendar",
    category: "Business",
    description: "Plan content by channel and publish date.",
    icon: "megaphone",
    defaultView: "table",
    columns: [
      status("Status", ["Idea", "Drafting", "Review", "Scheduled", "Published"]),
      select("Channel", ["Blog", "LinkedIn", "Newsletter", "YouTube"]),
      field("Publish date", "date"),
      field("Owner", "person"),
      field("URL", "url"),
    ],
    sampleRows: [
      { Task: "How we build boards", Status: "Drafting", Channel: "Blog", "Publish date": "Jun 12", Owner: "Maya", URL: "" },
    ],
  },
  {
    id: "blank",
    name: "Blank board",
    category: "Start from scratch",
    description: "Start with just a title column and add properties as you need them.",
    icon: "plus",
    defaultView: "table",
    columns: [],
    sampleRows: [{ Task: "Your first task" }],
  },
];

export const TEMPLATE_CATEGORIES: TemplateCategory[] = [
  "Personal",
  "Study",
  "Product & Engineering",
  "Business",
  "Start from scratch",
];

const newId = (prefix: "col" | "opt") =>
  `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

export function instantiateTemplate(template: BoardTemplate): Column[] {
  return template.columns.map((column) => ({
    id: newId("col"),
    name: column.name,
    type: column.type,
    ...(column.hidden ? { hidden: true } : {}),
    ...(column.options
      ? {
          options: column.options.map((option) => ({
            id: newId("opt"),
            label: option.label,
            ...(option.color ? { color: option.color } : {}),
          })),
        }
      : {}),
  }));
}
