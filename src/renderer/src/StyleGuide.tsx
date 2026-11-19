import { AlertTriangle, Copy, Folder, Inbox, Mic, Play, Settings, Star } from "lucide-react";
import { useState } from "react";
import { Button, Dialog, Field, IconButton, Kbd, Segmented, Select, Switch } from "./ui";

/** Dev-only living style guide (⌘⇧D). Every component in every state, on real tokens. */
const COLORS = [
  "window", "chrome", "raised", "control", "sidebar", "hover", "selected", "line", "line-strong",
  "line-control", "ink", "ink-2", "ink-3", "accent", "accent-soft", "accent-text", "focus", "record",
  "danger", "danger-soft", "success", "success-soft", "warning",
];
const TYPE = [
  ["2xl", "스타일 가이드 제목"], ["xl", "요약 제목"], ["lg", "주간 스프린트 회의 (도구 막대 제목)"],
  ["read", "쿠폰 문제는 동선님이 이번 주 수요일까지 수정하기로 했습니다."],
  ["base", "새 회의 녹음 · 회의 검색 · 설정"], ["sm", "00:14 · 전사 대기 2"], ["xs", "보관함 · 폴더"],
] as const;
const STATES = ["default", "hover", "focus", "active", "disabled", "loading", "error", "success"] as const;

export function StyleGuide() {
  const [dialog, setDialog] = useState(false);
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  return (
    <div className="guide selectable">
      <h1 className="guide__title">Seogi 디자인 시스템</h1>
      <p className="guide__lede">시스템 외관(라이트/다크)을 바꾸면 이 화면도 함께 바뀝니다.</p>

      <h2 className="guide__h">색</h2>
      <div className="guide__swatches">
        {COLORS.map((c) => (
          <div key={c} className="swatch">
            <span className="swatch__chip" style={{ background: `var(--color-${c})` }} />
            <code>--color-{c}</code>
          </div>
        ))}
      </div>

      <h2 className="guide__h">글자 · 시스템 글꼴 (SF Pro · Apple SD Gothic Neo)</h2>
      {TYPE.map(([t, sample]) => (
        <div key={t} className="guide__type">
          <code>--text-{t}</code>
          <span style={{ fontSize: `var(--text-${t})` }}>{sample}</span>
        </div>
      ))}

      <h2 className="guide__h">버튼 · 8 상태</h2>
      <div className="guide__grid">
        {STATES.map((st) => (
          <div key={st} className="guide__row">
            <code>{st}</code>
            {(["primary", "secondary", "ghost", "danger"] as const).map((v) => (
              <Button
                key={v}
                variant={v}
                className={["hover", "focus", "active"].includes(st) ? `is-${st}` : ""}
                disabled={st === "disabled"}
                state={st === "loading" || st === "error" || st === "success" ? st : undefined}
                icon={v === "primary" ? <Mic aria-hidden /> : undefined}
              >
                {st === "loading" ? "저장 중" : st === "error" ? "다시 시도" : st === "success" ? "저장됨" : "새 회의 녹음"}
              </Button>
            ))}
            <IconButton label="설정" className={["hover", "focus", "active"].includes(st) ? `is-${st}` : ""} disabled={st === "disabled"}>
              <Settings aria-hidden />
            </IconButton>
          </div>
        ))}
      </div>

      <h2 className="guide__h">입력</h2>
      <div className="guide__fields">
        <Field label="기본" helper="도움말은 아래에 한 줄 자리를 차지합니다.">
          {(a) => <input {...a} className="control" placeholder="동선, 큐그리드" />}
        </Field>
        <Field label="호버">{(a) => <input {...a} className="control is-hover" defaultValue="큐그리드" />}</Field>
        <Field label="포커스">{(a) => <input {...a} className="control is-focus" defaultValue="회의록 앱" />}</Field>
        <Field label="비활성">{(a) => <input {...a} className="control" disabled defaultValue="수정할 수 없음" />}</Field>
        <Field label="오류" error="API key가 올바르지 않습니다. 키를 다시 확인해 주세요.">
          {(a) => <input {...a} className="control" defaultValue="sk-invalid" />}
        </Field>
        <Field label="성공" helper="연결을 확인했습니다.">
          {(a) => <input {...a} className="control" data-state="success" defaultValue="http://localhost:44900" />}
        </Field>
        <Field label="선택">
          {(a) => (
            <Select {...a} defaultValue="qgrid">
              <option value="openai">OpenAI · API key</option>
              <option value="qgrid">qgrid</option>
            </Select>
          )}
        </Field>
      </div>

      <h2 className="guide__h">스위치 · 여러 칸 선택</h2>
      <div className="guide__row">
        <code>switch</code>
        <Switch label="꺼짐" checked={false} onChange={() => {}} />
        <Switch label="켜짐" checked onChange={() => {}} />
        <Switch label="호버" className="is-hover" checked={false} onChange={() => {}} />
        <Switch label="포커스" className="is-focus" checked onChange={() => {}} />
        <Switch label="비활성" disabled checked onChange={() => {}} />
      </div>
      <div className="guide__row">
        <code>segmented</code>
        <Segmented
          label="테마"
          value={theme}
          onChange={setTheme}
          options={[
            { value: "system", label: "시스템" },
            { value: "light", label: "라이트" },
            { value: "dark", label: "다크" },
          ]}
        />
      </div>

      <h2 className="guide__h">사이드바 항목 · 회의 목록</h2>
      <div className="guide__row" style={{ alignItems: "flex-start" }}>
        <ul className="guide__channels">
          <li><button type="button" className="side-item"><Inbox aria-hidden /><span className="side-item__label">기본</span><span className="side-item__count">12</span></button></li>
          <li><button type="button" className="side-item" aria-current><Star aria-hidden /><span className="side-item__label">선택됨</span><span className="side-item__count">3</span></button></li>
          <li><button type="button" className="side-item" data-drop><Folder aria-hidden /><span className="side-item__label">끌어다 놓는 중</span></button></li>
          <li><button type="button" className="side-item" data-tone="danger"><AlertTriangle aria-hidden /><span className="side-item__label">오류</span><span className="side-item__count">2</span></button></li>
        </ul>
        <ul className="list__rows guide__list" tabIndex={0} role="listbox" aria-label="예시">
          {[
            { t: "주간 스프린트 회의", sel: true, unread: false },
            { t: "안 읽은 요약", sel: false, unread: true },
          ].map((r) => (
            <li key={r.t} className="row" role="option" aria-selected={r.sel} data-unread={r.unread || undefined}>
              <div className="row__line">
                {r.unread && <span className="row__dot" />}
                <span className="row__title">{r.t}</span>
                <span className="row__date tnum">오후 4:48</span>
              </div>
              <p className="row__preview">결제 기능 버그 두 건과 대시보드 개편 일정을 정했습니다.</p>
              <div className="row__meta"><span className="row__status" data-status="recording"><span className="live-dot" />녹음 중</span><span>32분</span></div>
            </li>
          ))}
        </ul>
      </div>
      <p className="guide__lede">목록을 클릭해 포커스를 주면 선택 행이 강조색이 되고, 창이 뒤로 가면 회색이 됩니다.</p>

      <h2 className="guide__h">메시지 묶음</h2>
      <ol className="msg-group guide__messages">
        <li className="msg msg--head">
          <div className="msg__gutter"><span className="avatar" data-speaker="system">상대</span></div>
          <div>
            <div className="msg__head"><span className="msg__name">상대</span><span className="msg__time tnum">00:14</span></div>
            <p className="msg__text">이번 주 스프린트 회의를 시작하겠습니다.</p>
          </div>
        </li>
        <li className="msg is-hover">
          <div className="msg__gutter"><span className="msg__gutter-time tnum">00:18</span></div>
          <div><p className="msg__text">먼저 지난주에 배포한 결제 기능에서 버그가 두 건 발견되었습니다.</p></div>
          <div className="msg__actions">
            <IconButton label="이 지점부터 듣기"><Play aria-hidden /></IconButton>
            <IconButton label="복사"><Copy aria-hidden /></IconButton>
          </div>
        </li>
      </ol>
      <ol className="msg-group guide__messages">
        <li className="msg msg--head">
          <div className="msg__gutter"><span className="avatar" data-speaker="mic">나</span></div>
          <div>
            <div className="msg__head"><span className="msg__name" data-speaker="mic">나</span><span className="msg__time tnum">00:38</span></div>
            <p className="msg__text">네, 쿠폰 건은 수요일까지 고치겠습니다.</p>
          </div>
        </li>
      </ol>

      <h2 className="guide__h">대화상자 · 단축키</h2>
      <div className="guide__row">
        <Button onClick={() => setDialog(true)}>대화상자 열기</Button>
        <Kbd>⌘K</Kbd>
        <Kbd>⌘,</Kbd>
        <Kbd>esc</Kbd>
      </div>
      <Dialog open={dialog} onClose={() => setDialog(false)} label="예시 대화상자">
        <div className="dialog__head"><h2 className="dialog__title">녹음을 끝낼까요?</h2></div>
        <div className="dialog__body"><p>지금까지 녹음한 내용을 받아 적고 요약을 만듭니다.</p></div>
        <div className="dialog__foot">
          <Button variant="ghost" onClick={() => setDialog(false)}>계속 녹음</Button>
          <Button variant="primary" onClick={() => setDialog(false)}>녹음 종료</Button>
        </div>
      </Dialog>
    </div>
  );
}
