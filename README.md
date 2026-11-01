# 플랫폼트리 Claude 스킬 (Mac 버전)

> 원본 [platformtree-claude-skills](https://github.com/codmsdncodusdn-web/platformtree-claude-skills)에서 갈라진 **Mac 대응 버전**입니다. Claude 앱이 Homebrew(`/opt/homebrew/bin`)에 설치한 FFmpeg·Node를 못 찾는 문제를 고쳤습니다. 아직 실제 Mac에서 전 과정을 시험하지는 못했어요. 안 되는 곳이 있으면 이슈로 알려 주세요.

Claude에게 말 한마디로 영상 편집을 맡기는 스킬 모음입니다.

| 스킬 | 하는 일 |
|---|---|
| **cut-filler** | 말하는 영상에서 "음", "어" 같은 군말, 말 사이 무음, 다시 말한 NG 테이크를 자동으로 잘라냅니다 |

---

## 준비물

- **Claude 데스크톱 앱** (Code 탭) 또는 터미널의 Claude Code
  - claude.ai 웹 채팅에서는 동작하지 않아요. 내 컴퓨터에서 영상을 직접 자르기 때문이에요.
- **Node.js 18 이상**, **FFmpeg**
  - 없으면 설치 후 Claude가 알려 줍니다. 미리 설치하려면:

  | | Windows (PowerShell) | Mac (터미널) |
  |---|---|---|
  | Node.js | `winget install OpenJS.NodeJS.LTS` | `brew install node` |
  | FFmpeg | `winget install Gyan.FFmpeg` | `brew install ffmpeg` |

- 처음 한 번 **한국어 받아쓰기 모델(약 570MB)** 을 내려받아요. 와이파이가 좋은 곳에서 해 주세요.

## 설치

### 방법 1. 한 줄 설치 (추천)

**Windows** — PowerShell을 열고 붙여넣기:

```powershell
irm https://raw.githubusercontent.com/codmsdncodusdn-web/platformtree-claude-skills-mac/main/install.ps1 | iex
```

**Mac** — 터미널을 열고 붙여넣기:

```bash
curl -fsSL https://raw.githubusercontent.com/codmsdncodusdn-web/platformtree-claude-skills-mac/main/install.sh | bash
```

설치가 끝나면 Claude 앱을 다시 열어 주세요. 업데이트할 때도 같은 명령을 다시 실행하면 됩니다.

### 방법 2. Claude에게 부탁하기

Claude 앱에 이렇게 말하세요:

> https://github.com/codmsdncodusdn-web/platformtree-claude-skills-mac 저장소의 cut-filler 스킬을 내 ~/.claude/skills 폴더에 설치해줘

### 방법 3. 플러그인으로 설치 (터미널 Claude Code)

```
/plugin marketplace add codmsdncodusdn-web/platformtree-claude-skills-mac
/plugin install cut-filler@platformtree
```

## 사용법

영상 파일을 Claude 창에 끌어다 놓고 말하세요.

> 이 영상에서 음, 어 같은 군말이랑 무음 잘라줘

Claude가 받아쓰기 → 지울 곳 판단 → 자르기까지 하고, 무엇을 잘랐는지 알려 줍니다.

### 이렇게도 말할 수 있어요

| 말 | 결과 |
|---|---|
| "더 타이트하게 잘라줘" | 짧은 무음까지 잘라요 (강도 **강**) |
| "여운 좀 살려줘" | 긴 무음만 잘라요 (강도 **약**) |
| "3초쯤 '그러니까'는 살려줘" | 그 부분만 되살려요 |
| "프리미어에서 마무리할게" | XML 가져오는 방법을 알려 줘요 |

### 결과물

영상 옆에 `<영상이름>_cut` 폴더가 생깁니다.

| 파일 | 내용 |
|---|---|
| `<영상이름>_cut.mp4` | 컷 편집된 영상 (원본 화질 유지) |
| `<영상이름>_cut.xml` | **프리미어 프로·다빈치 리졸브**용. 파일 → 가져오기로 열면 컷이 적용된 시퀀스가 생겨요. 원본 영상을 그대로 쓰니 원본을 옮기지 마세요 |
| `report.txt` | 원래 길이 → 결과 길이, 지운 말 목록 |

> CapCut은 XML을 읽지 못해요. CapCut에서는 `_cut.mp4`를 불러와 이어서 편집하세요.

## 어떻게 동작하나요

1. **받아쓰기**: 내 컴퓨터에서 Whisper로 단어마다 시간을 기록합니다. 영상이 밖으로 나가지 않아요.
2. **후보 찾기**
   - 무음 구간
   - 받아쓴 군말 ("음", "어", 문맥상 군말인 "그", "저", "이제"…)
   - 받아쓰기엔 없지만 소리가 나는 틈 (Whisper가 빼먹은 "음…")
   - 같은 말을 다시 시작한 NG 테이크
3. **Claude 판단**: 문맥을 읽고 진짜 지울 것만 고릅니다. 애매하면 남겨요. ([판단 기준](plugins/cut-filler/skills/cut-filler/RULES.md))
4. **자르기**: 자르는 지점을 가까운 조용한 곳으로 옮기고, 이음새마다 짧은 페이드를 넣어 "틱" 소리를 막습니다.

## 문제 해결

| 증상 | 해결 |
|---|---|
| "FFmpeg 없음" | 위 표의 설치 명령 실행 → **Claude 앱을 완전히 껐다 켜기** |
| 받아쓰기 모델 다운로드가 멈춤 | 인터넷 연결 확인 후 "환경 다시 점검해줘"라고 말하기 |
| 의미 있는 말이 잘림 | "○○ 부분 살려줘" 또는 "덜 자르게 해줘" |
| 프리미어에서 "미디어 오프라인" | 원본 영상을 처음 위치로 되돌리거나, 프리미어에서 미디어 다시 연결 |

## 라이선스

[MIT](LICENSE) © 플랫폼트리
