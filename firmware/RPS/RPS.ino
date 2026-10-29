// RPS: 가위바위보 심판 (UNO). 직접 작성한 펌웨어이며 외부 코드·라이브러리를 쓰지 않습니다.
//
// 아두이노가 두 손을 받아 승패를 직접 판정하고 LED로 알립니다.
//   초록 LED(D3) = 이김 / 노랑 LED(D4) = 비김 / 빨강 LED(D5) = 짐·시간 초과
//
// 통신: USB 시리얼 115200, 한 줄에 "요청번호 명령 인수" (줄 끝은 \n)
//   STATUS              현재 상태 요청
//   PING                연결 확인
//   STOP                모든 LED 끄기
//   SIGNAL <0~3>        점검용: 0 끔, 1 빨강, 2 노랑, 3 초록
//   JUDGE <내 손> <상대 손>   손: 0=가위 1=바위 2=보, 내 손 3=못 냄(시간 초과)
// 응답은 JSON 한 줄입니다: {"v":1,"type":"ack|error|state", ...}

const byte PIN_GREEN = 3;   // 이김
const byte PIN_YELLOW = 4;  // 비김
const byte PIN_RED = 5;     // 짐 / 시간 초과

char lineBuf[40];
byte lineLen = 0;
bool lineTooLong = false;
byte signalState = 0;
const char *lastResult = NULL;   // "win" / "draw" / "lose" / "timeout", 판정 전에는 NULL
unsigned long lastReport = 0;

/**
 * 신호등 LED 하나만 켠다.
 * @param value 0 모두 끔, 1 빨강, 2 노랑, 3 초록
 */
void setSignal(byte value)
{
    signalState = value;
    digitalWrite(PIN_RED, value == 1 ? HIGH : LOW);
    digitalWrite(PIN_YELLOW, value == 2 ? HIGH : LOW);
    digitalWrite(PIN_GREEN, value == 3 ? HIGH : LOW);
}

void replyAck(unsigned int id)
{
    Serial.print(F("{\"v\":1,\"type\":\"ack\",\"request\":"));
    Serial.print(id);
    Serial.println(F(",\"applied\":true}"));
}

void replyError(unsigned int id, const __FlashStringHelper *code)
{
    Serial.print(F("{\"v\":1,\"type\":\"error\",\"request\":"));
    Serial.print(id);
    Serial.print(F(",\"code\":\""));
    Serial.print(code);
    Serial.println(F("\"}"));
}

void replyState(unsigned int id)
{
    Serial.print(F("{\"v\":1,\"type\":\"state\",\"profile\":\"RPS\",\"request\":"));
    Serial.print(id);
    Serial.print(F(",\"ms\":"));
    Serial.print(millis());
    Serial.print(F(",\"last_key\":\"-\",\"signal\":"));
    Serial.print(signalState);
    Serial.print(F(",\"result\":"));
    if (lastResult)
    {
        Serial.print('"');
        Serial.print(lastResult);
        Serial.print('"');
    }
    else
    {
        Serial.print(F("null"));
    }
    Serial.println('}');
}

/**
 * 문자열 p에서 정수 하나를 읽는다. 앞의 공백은 건너뛰고, 숫자 뒤에는 공백이나 끝만 허용한다.
 * @param p   읽는 위치(성공하면 숫자 뒤로 이동)
 * @param lo  허용 최솟값
 * @param hi  허용 최댓값
 * @param out 읽은 값
 * @return 범위 안의 정수를 읽으면 true
 */
bool readInt(const char *&p, long lo, long hi, long &out)
{
    while (*p == ' ')
    {
        p++;
    }
    if (*p < '0' || *p > '9')
    {
        return false;
    }
    long v = 0;
    while (*p >= '0' && *p <= '9')
    {
        v = v * 10 + (*p - '0');
        if (v > 100000L)
        {
            return false;
        }
        p++;
    }
    if (*p != '\0' && *p != ' ')
    {
        return false;
    }
    if (v < lo || v > hi)
    {
        return false;
    }
    out = v;
    return true;
}

/** 남은 글자가 공백뿐인지 확인한다. */
bool atEnd(const char *p)
{
    while (*p == ' ')
    {
        p++;
    }
    return *p == '\0';
}

/**
 * 가위0 바위1 보2 에서 (나 - 상대 + 3) % 3 이 1이면 이김, 0이면 비김, 2이면 짐.
 * @param mine 내 손(3이면 못 냄)
 * @param opp  상대 손
 */
const char *judge(byte mine, byte opp)
{
    if (mine == 3)
    {
        return "timeout";
    }
    byte d = (mine + 3 - opp) % 3;
    return d == 1 ? "win" : d == 0 ? "draw" : "lose";
}

/** 한 줄 명령을 해석해 실행하고 응답한다. */
void handleLine(const char *s)
{
    const char *p = s;
    long id = 0;
    if (!readInt(p, 1, 65535L, id))
    {
        replyError(0, F("request"));
        return;
    }
    unsigned int req = (unsigned int)id;
    while (*p == ' ')
    {
        p++;
    }
    char cmd[8];
    byte n = 0;
    while (*p != '\0' && *p != ' ' && n < sizeof(cmd) - 1)
    {
        cmd[n++] = *p++;
    }
    cmd[n] = '\0';
    if (*p != '\0' && *p != ' ')
    {
        replyError(req, F("unsupported_or_range"));
        return;
    }

    long a = 0;
    long b = 0;
    if (!strcmp(cmd, "STATUS") && atEnd(p))
    {
        replyState(req);
    }
    else if (!strcmp(cmd, "PING") && atEnd(p))
    {
        replyAck(req);
    }
    else if (!strcmp(cmd, "STOP") && atEnd(p))
    {
        setSignal(0);
        lastResult = NULL;
        replyAck(req);
        replyState(req);
    }
    else if (!strcmp(cmd, "SIGNAL") && readInt(p, 0, 3, a) && atEnd(p))
    {
        setSignal((byte)a);
        lastResult = NULL;
        replyAck(req);
    }
    else if (!strcmp(cmd, "JUDGE") && readInt(p, 0, 3, a) && readInt(p, 0, 2, b) && atEnd(p))
    {
        lastResult = judge((byte)a, (byte)b);
        setSignal(!strcmp(lastResult, "win") ? 3 : !strcmp(lastResult, "draw") ? 2 : 1);
        replyAck(req);
        replyState(req);
    }
    else
    {
        replyError(req, F("unsupported_or_range"));
    }
}

/** 시리얼로 들어온 글자를 모아 한 줄이 완성되면 처리한다. */
void readSerial()
{
    byte budget = 64;
    while (budget-- && Serial.available())
    {
        char c = Serial.read();
        if (c == '\r')
        {
            continue;
        }
        if (c == '\n')
        {
            if (lineTooLong)
            {
                replyError(0, F("line_too_long"));
            }
            else if (lineLen > 0)
            {
                lineBuf[lineLen] = '\0';
                handleLine(lineBuf);
            }
            lineLen = 0;
            lineTooLong = false;
        }
        else if (!lineTooLong)
        {
            if (lineLen < sizeof(lineBuf) - 1)
            {
                lineBuf[lineLen++] = c;
            }
            else
            {
                lineTooLong = true;
                lineLen = 0;
            }
        }
    }
}

void setup()
{
    Serial.begin(115200);
    pinMode(PIN_RED, OUTPUT);
    pinMode(PIN_YELLOW, OUTPUT);
    pinMode(PIN_GREEN, OUTPUT);
    setSignal(0);   // 시작할 때는 모두 꺼짐
}

void loop()
{
    readSerial();
    unsigned long now = millis();
    if (now - lastReport >= 1000)
    {
        lastReport = now;
        replyState(0);   // 1초마다 자동 보고 (request=0)
    }
}
