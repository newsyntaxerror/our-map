/* ─────────────────────────────────────────────────────────────
   우리끼리 — 설정 파일
   ─────────────────────────────────────────────────────────────

   1) 그냥 체험해 보기
      아래 두 칸을 비워 둔 채로 열면 '체험(데모) 모드'로 실행됩니다.
      내 브라우저 위치(권한이 없으면 서울 도심 기준 좌표)와
      테스트용 친구 2명(민지·현우)이 지도에 표시되고 계속 움직여요.

   2) 친구·가족과 실제로 위치 주고받기 (여러 기기)
      · supabase.com 에서 무료 프로젝트를 하나 만듭니다.
      · Supabase 대시보드 → SQL Editor 에 supabase_schema.sql 내용을
        통째로 붙여넣고 RUN 합니다. (표 + 접근 권한 + 실시간 설정)
      · Project Settings → API 에서 Project URL 과 anon public key 를 복사해
        아래에 넣습니다.
      · 이 폴더를 웹에 올리면(Netlify Drop, GitHub Pages 등) 끝!
   ───────────────────────────────────────────────────────────── */

window.APP_CONFIG = {
  SUPABASE_URL: "",        // 예: "https://abcdefghijklmnop.supabase.co"
  SUPABASE_ANON_KEY: "",   // 예: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."

  ROOM_PREFIX: "DALKONG",  // '새 방 만들기'에서 쓰는 앞부분 (예: DALKONG-7Q4M)
  REFRESH_SECONDS: 10,     // 자동 갱신 주기(초)
};
