import { ArrowRight, CalendarDays, Check, Circle, House, List, Play, Plus } from "lucide-react";

export function WebsiteResult() {
  return (
    <div className="demo-artifact demo-website">
      <div className="demo-site-nav"><strong>Fieldwork Studio</strong><span>Work&nbsp;&nbsp; About</span></div>
      <div className="demo-site-copy">
        <p>Spaces to<br />slow down.</p>
        <span>Explore our work <ArrowRight size={10} /></span>
      </div>
      <svg className="demo-site-art" viewBox="0 0 180 110" preserveAspectRatio="xMidYMid slice">
        <rect width="180" height="110" fill="#e6d2ad" />
        <circle cx="135" cy="27" r="15" fill="#f8e8c8" />
        <path d="M0 67Q29 47 64 59T122 58T180 62V110H0Z" fill="#9da18a" />
        <path d="M0 85Q52 59 101 76T180 78V110H0Z" fill="#747e68" />
        <path d="M33 91V53L84 33L133 54V91Z" fill="#e5ceab" />
        <path d="M84 33L133 54L153 48L106 29Z" fill="#565f4d" />
        <path d="M133 54L153 48V83L133 91Z" fill="#b99773" />
        <path d="M43 59L83 44L124 60V90H43Z" fill="#46534a" />
        <path d="M45 60L83 46L122 61L117 66L84 54L49 66Z" fill="#8f9a85" />
        <path d="M83 46V91M62 54V91M104 54V91M44 73H123" stroke="#dec19a" strokeWidth="2" />
        <path d="M0 99Q35 82 79 96T180 87V110H0Z" fill="#566650" />
        <path d="M19 99V80m0 14-7-8m7 5 6-7m135 12V77m0 14 8-7m-8 4-5-5" fill="none" stroke="#b5b797" strokeLinecap="round" />
      </svg>
    </div>
  );
}

const STUDY_DAYS = [
  ["Monday", "Practice Python"],
  ["Tuesday", "Review"],
  ["Wednesday", "Quiz"],
];

export function StudyResult() {
  return (
    <div className="demo-artifact demo-study">
      <div className="demo-study-heading">
        <span><CalendarDays size={13} /> This week</span>
        <div className="demo-study-progress"><span>1 of 3</span><i /></div>
      </div>
      <dl>
        {STUDY_DAYS.map(([day, activity], index) => (
          <div key={day}>
            <dt>{day}</dt>
            <dd>{activity}{index === 0 ? <Check size={12} /> : <Circle size={10} />}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function PocketTasks() {
  return (
    <div className="demo-phone">
      <span className="demo-phone-camera" />
      <strong>Today</strong>
      <span className="demo-phone-task"><Check size={8} /> Review notes</span>
      <span className="demo-phone-task"><Circle size={7} /> Send draft</span>
      <span className="demo-phone-nav"><House size={9} /><List size={9} /><Plus size={9} /></span>
    </div>
  );
}

export function AppResult() {
  return (
    <div className="demo-artifact demo-app">
      <div className="demo-app-copy"><span>POCKET TASKS</span><p>A little more<br />organized.</p></div>
      <PocketTasks />
    </div>
  );
}

export function VideoResult() {
  return (
    <div className="demo-artifact demo-video">
      <div className="demo-video-frame">
        <div className="demo-video-copy"><span>POCKET TASKS</span><p>Make room<br />for your day.</p></div>
        <div className="demo-video-phone"><PocketTasks /></div>
      </div>
      <div className="demo-video-controls"><Play size={10} fill="currentColor" /><span /><i>0:06</i></div>
    </div>
  );
}
