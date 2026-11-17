import { useEffect, useState } from "react";
import {
  DEFAULT_MODELS,
  type Settings,
  type SummaryProvider,
  type TranscriptionProvider,
} from "../../shared/types";
import { Button, Dialog, Field, Select } from "./ui";

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} label="설정">
      <SettingsBody onClose={onClose} />
    </Dialog>
  );
}

function SettingsBody({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [keys, setKeys] = useState({ openai: "", anthropic: "" });
  const [saving, setSaving] = useState<"loading" | "error" | undefined>();
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => void window.api.getSettings().then(setS), []);
  if (!s) return null;

  const set = (patch: Partial<Settings>) => setS({ ...s, ...patch });
  const needs = (p: string) => s.transcription.provider === p || s.summary.provider === p;

  async function save() {
    if (!s) return;
    setSaving("loading");
    setSaveError(null);
    const { hasKey: _, ...rest } = s;
    try {
      await window.api.saveSettings({
        ...rest,
        keys: { openai: keys.openai || undefined, anthropic: keys.anthropic || undefined },
      });
      onClose();
    } catch (e) {
      setSaving("error");
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="dialog__head">
        <h2 className="dialog__title">설정</h2>
      </div>
      <div className="dialog__body">
        <Field label="전사" helper="말을 글로 옮기는 모델입니다.">
          {(a) => (
            <div className="field-row">
              <Select
                {...a}
                value={s.transcription.provider}
                onChange={(e) => {
                  const provider = e.target.value as TranscriptionProvider;
                  set({ transcription: { provider, model: DEFAULT_MODELS.transcription[provider] } });
                }}
              >
                <option value="openai">OpenAI · API key</option>
                <option value="qgrid">qgrid</option>
              </Select>
              <input
                className="control"
                aria-label="전사 모델 ID"
                value={s.transcription.model}
                placeholder={DEFAULT_MODELS.transcription[s.transcription.provider]}
                onChange={(e) => set({ transcription: { ...s.transcription, model: e.target.value } })}
              />
            </div>
          )}
        </Field>

        <Field label="요약" helper="회의가 끝난 뒤 요약과 액션아이템을 만드는 모델입니다.">
          {(a) => (
            <div className="field-row">
              <Select
                {...a}
                value={s.summary.provider}
                onChange={(e) => {
                  const provider = e.target.value as SummaryProvider;
                  set({ summary: { provider, model: DEFAULT_MODELS.summary[provider] } });
                }}
              >
                <option value="openai">OpenAI · API key</option>
                <option value="anthropic">Anthropic · API key</option>
                <option value="qgrid">qgrid</option>
              </Select>
              <input
                className="control"
                aria-label="요약 모델 ID"
                value={s.summary.model}
                placeholder={DEFAULT_MODELS.summary[s.summary.provider]}
                onChange={(e) => set({ summary: { ...s.summary, model: e.target.value } })}
              />
            </div>
          )}
        </Field>

        {needs("qgrid") && (
          <Field label="qgrid 주소" helper="로컬이면 http://localhost:44900">
            {(a) => <input {...a} className="control" value={s.qgridUrl} onChange={(e) => set({ qgridUrl: e.target.value })} />}
          </Field>
        )}

        {needs("openai") && (
          <Field
            label="OpenAI API key"
            helper={s.hasKey.openai ? <span className="field-hint">저장됨 · 바꿀 때만 입력하세요</span> : "키체인으로 암호화해 이 맥에만 저장합니다."}
          >
            {(a) => (
              <input
                {...a}
                className="control"
                type="password"
                autoComplete="off"
                placeholder="sk-…"
                value={keys.openai}
                onChange={(e) => setKeys({ ...keys, openai: e.target.value })}
              />
            )}
          </Field>
        )}

        {needs("anthropic") && (
          <Field
            label="Anthropic API key"
            helper={s.hasKey.anthropic ? <span className="field-hint">저장됨 · 바꿀 때만 입력하세요</span> : "키체인으로 암호화해 이 맥에만 저장합니다."}
          >
            {(a) => (
              <input
                {...a}
                className="control"
                type="password"
                autoComplete="off"
                placeholder="sk-ant-…"
                value={keys.anthropic}
                onChange={(e) => setKeys({ ...keys, anthropic: e.target.value })}
              />
            )}
          </Field>
        )}

        <Field label="용어집" helper="사람 이름, 제품명을 쉼표로 구분해 적으면 받아 적을 때 표기를 맞춥니다." error={saveError ?? undefined}>
          {(a) => (
            <textarea
              {...a}
              className="control"
              rows={3}
              placeholder="동선, 큐그리드, 회의록 앱"
              value={s.glossary}
              onChange={(e) => set({ glossary: e.target.value })}
            />
          )}
        </Field>
      </div>
      <div className="dialog__foot">
        <Button variant="ghost" onClick={onClose}>
          취소
        </Button>
        <Button variant="primary" type="submit" state={saving}>
          {saving === "error" ? "다시 저장" : "저장"}
        </Button>
      </div>
    </form>
  );
}
