# Seogi (서기)

회의를 녹음하고, 받아 적고, 끝나면 요약과 액션아이템을 정리하는 macOS 앱입니다.

- 마이크와 시스템 오디오를 따로 녹음해 "나"와 "상대"를 구분합니다.
- 말이 끊기는 지점마다 30초 안팎으로 잘라 회의 중에도 받아 적습니다.
- 회의가 끝나면 개요, 결정사항, 액션아이템, 주제별 정리를 만듭니다.
- 지난 회의는 제목, 요약, 대화 내용으로 검색합니다(⌘K).

전사와 요약 모델은 설정(⌘,)에서 고릅니다. OpenAI·Anthropic API key를 넣거나, qgrid 서버 주소를 지정합니다. API key는 macOS 키체인으로 암호화해 이 맥에만 저장합니다.

## 실행

```sh
mise install
mise exec -- pnpm install
mise run dev
```

macOS 14.2 이상이 필요합니다(시스템 오디오 녹음). 처음 녹음할 때 마이크와 화면·오디오 녹음 권한을 허용해야 합니다.

## 개발

- `mise run check`: 타입 검사, 테스트, 빌드
- 디자인 시스템: [`design.md`](design.md), 개발 모드에서 ⌘⇧D로 스타일 가이드
- 데이터 위치: `~/Library/Application Support/Seogi`
