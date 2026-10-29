# 가위바위보!

웹캠으로 내 손(가위·바위·보)을 읽고, 상대(컴퓨터)와 대결하는 웹 게임. UNO 신호등 LED가 결과를 알려 준다.

- 상대 손이 돌아가다가 "가위! 바위! 보!" → 3초 안에 내 손 확정(0.4초 유지) → 동시에 공개
- 🟢 초록 = 이김 (+3) · 🟡 노랑 = 비김 (+1) · 🔴 빨강 = 짐 또는 시간 초과 (0)
- **판정은 아두이노가 한다**: `JUDGE 내손 상대손`(가위0 바위1 보2, 내 손 3=못 냄) → 보드가 승패를 계산해 LED를 켜고 결과를 응답한다.
- 서버 없이 정적 페이지(GitHub Pages)로 동작한다.

## 페이지
| 페이지 | 내용 |
|---|---|
| `index.html` 게임하기 | 웹캠 VS 상대 이미지 대결, 점수판, 기록, 설정 |
| `setup.html` 장치 연결 | 웹캠 켜기, UNO 연결, LED 시험, 데모 모드, 배선·업로드 안내 |
| `a11y.html` 접근성 | WCAG 2.2 AA 점검표 |

## 실행
Chrome/Edge로 연다. 장치 연결 페이지에서 웹캠과 UNO를 한 번 허용하면 게임 페이지가 자동으로 다시 연결한다. 장치가 없으면 "데모 모드".

## 아두이노
`firmware/RPS/RPS.ino` 한 파일을 Uno로 업로드 (라이브러리 불필요, 115200). 초록 D3 · 노랑 D4 · 빨강 D5, 각 LED에 저항(1kΩ), − 쪽은 GND.

## 저작권·외부 자료
- 이 저장소의 코드·그림(장갑 손 SVG)·BGM(Web Audio로 합성)은 직접 만들었다.
- **상대 이미지와 노래는 저장소에 없다.** 사용자가 자기 컴퓨터의 파일을 고르면 그 브라우저(IndexedDB)에만 저장되고 서버로 올라가지 않는다. 저작권이 있는 자료는 개인·수업 시연 범위에서만 쓸 것.
- 손 인식: [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) (Apache-2.0)을 CDN에서 불러온다(저장소에 포함하지 않음).
- 글꼴: [Jua](https://fonts.google.com/specimen/Jua) (SIL OFL 1.1), Google Fonts에서 불러온다.
- 디자인 참고: [nexu-io/open-design](https://github.com/nexu-io/open-design) (Apache-2.0)의 `claymorphism`·`doodle`·`duolingo` 디자인 시스템 설명과 접근성 기준 문서. 코드는 가져오지 않았다.

## 접근성
WCAG 2.2 AA 목표. 점검표의 "설계됨"은 실측 검증이 아니다.
