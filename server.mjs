import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

try {
  const envText = readFileSync(join(root, '.env'), 'utf8');
  for (const rawLine of envText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
} catch (error) {
  if (error.code !== 'ENOENT') console.warn('.env 파일을 읽지 못했습니다:', error.message);
}

const port = Number(process.env.PORT || 4173);
const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const analysisModel = process.env.GEMINI_ANALYSIS_MODEL || 'gemini-3.5-flash-lite';
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

async function parseBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 60_000_000) throw new Error('요청이 너무 큽니다.');
  }
  return JSON.parse(body || '{}');
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function buildPrompt(data) {
  const history = (data.history || []).map((h, i) => `${i + 1}. 질문: ${h.question}\n답변: ${h.answer}\n평가: ${h.feedback || '없음'}`).join('\n\n');
  return `당신은 한국의 냉철하지만 공정한 채용 면접관입니다. 아래 면접 맥락과 지원자의 답변을 평가하세요.

[면접 설정]
면접 대상: ${data.targetType || '기업'}
지원 기관/분야: ${data.company || '-'} / ${data.role || '-'}
면접 유형: ${data.interviewType || '-'}
진행 인원: ${data.format || '-'}
추가 면접 형식: ${data.interviewStyle || '없음'}
경력 수준: ${data.level || '-'}
직접 입력한 지원 내용: ${data.context || ((data.pdfNames || []).length ? `첨부 PDF(${data.pdfNames.join(', ')})를 우선 참고` : '-')}
사용자가 준비한 예상 질문: ${(data.expectedQuestions || []).join(' | ') || '-'}

[면접 시작 전 자료 분석 결과]
${data.preAnalysis ? JSON.stringify(data.preAnalysis, null, 2) : '사전 분석 결과 없음'}

[이전 대화]
${history || '첫 질문'}

[현재]
질문: ${data.question}
지원자 답변: ${data.answer}

평가 원칙:
- 정답/오답만 판정하지 말고 직무 관련성, 구체성, 논리성, 전달력, 진정성을 평가합니다.
- 답변에 근거가 부족하거나 모호하면 자연스러운 꼬리질문을 만듭니다.
- 피드백은 한국어로 구체적이고 실행 가능하게 작성합니다.
- nextQuestion은 답변을 파고드는 꼬리질문 또는 아직 다루지 않은 예상 질문이어야 합니다.
- 개선 답변은 지원자가 실제 말할 법한 40~70초 분량의 간결한 예시입니다.`;
}

const schema = {
  type: 'OBJECT',
  properties: {
    score: { type: 'INTEGER' },
    verdict: { type: 'STRING' },
    strengths: { type: 'ARRAY', items: { type: 'STRING' } },
    improvements: { type: 'ARRAY', items: { type: 'STRING' } },
    feedback: { type: 'STRING' },
    improvedAnswer: { type: 'STRING' },
    nextQuestion: { type: 'STRING' }
  },
  required: ['score', 'verdict', 'strengths', 'improvements', 'feedback', 'improvedAnswer', 'nextQuestion']
};

const questionsSchema = {
  type: 'OBJECT',
  properties: {
    briefing: {
      type: 'OBJECT',
      properties: {
        profileSummary: { type: 'STRING' },
        motivation: { type: 'STRING' },
        keyExperiences: { type: 'ARRAY', items: { type: 'STRING' } },
        strengths: { type: 'ARRAY', items: { type: 'STRING' } },
        risks: { type: 'ARRAY', items: { type: 'STRING' } },
        verificationPoints: { type: 'ARRAY', items: { type: 'STRING' } }
      },
      required: ['profileSummary', 'motivation', 'keyExperiences', 'strengths', 'risks', 'verificationPoints']
    },
    questions: { type: 'ARRAY', items: { type: 'STRING' } }
  },
  required: ['briefing', 'questions']
};

async function extractQuestions(req, res) {
  if (!process.env.GEMINI_API_KEY) return json(res, 503, { error: '예상 질문 PDF 분석에는 GEMINI_API_KEY가 필요합니다.' });
  try {
    const data = await parseBody(req);
    const questionPdfs = Array.isArray(data.questionPdfData) ? data.questionPdfData.filter(Boolean) : [];
    const applicationPdfs = Array.isArray(data.applicationPdfData) ? data.applicationPdfData.filter(Boolean) : [];
    if (!questionPdfs.length && !(data.expectedQuestions || []).length && !applicationPdfs.length && !data.context) return json(res, 400, { error: '분석할 지원 자료가 없습니다.' });
    const prompt = `당신은 실제 선발 면접을 설계하는 전문 면접관입니다.
사용자가 제공한 예상 질문 텍스트와 예상 질문 PDF들은 선택적인 참고 자료입니다. 자료가 있다면 질문 대본으로 읽지 말고 출제 의도·평가 역량·주제·난이도만 분석하세요.
${applicationPdfs.length ? '지원서 PDF들은 지원자의 실제 제출 자료입니다. 지원 동기, 경험, 연구·활동 계획, 성과와 모호한 부분을 서로 교차 분석해 질문 근거로 사용하세요.' : ''}
예상 질문 자료가 전혀 없어도 지원서와 면접 맥락만으로 실제 면접에서 나올 법한 질문을 새롭게 설계하세요.

[면접 맥락]
면접 대상: ${data.targetType || '-'}
기관/분야: ${data.company || '-'} / ${data.role || '-'}
면접 유형: ${data.interviewType || '-'}
진행 인원: ${data.format || '-'}
추가 면접 형식: ${data.interviewStyle || '없음'}
지원 단계: ${data.level || '-'}
직접 입력한 지원 내용: ${data.context || '-'}
사용자가 입력한 예상 질문 참고 자료:
${(data.expectedQuestions || []).map((question, index) => `${index + 1}. ${question}`).join('\n') || '(PDF만 제공됨)'}

[질문 생성 규칙]
- 먼저 모든 지원 자료를 종합해 profileSummary, motivation, keyExperiences, strengths, risks, verificationPoints로 구성된 면접관용 briefing을 작성하세요.
- briefing은 이후 면접 전체에서 PDF 원문 대신 사용할 수 있을 만큼 구체적으로 작성하되, 자료에 없는 사실을 만들지 마세요.
- 입력된 질문이나 PDF 문장을 그대로 복사하거나 단순히 어미만 바꾸지 마세요.
- 원문 질문과 문장 구조 및 핵심 표현이 동일한 질문은 절대 반환하지 마세요.
- 예상 질문 자료에서 평가 의도와 핵심 역량을 추론한 뒤, 해당 지원처와 지원자의 내용에 맞는 새로운 질문으로 재구성하세요.
- 질문 절반 이상은 지원서 또는 지원 내용에 있는 구체적인 경험·주장·계획을 언급하는 검증 질문이어야 합니다.
- 자료에 직접 적혀 있지 않더라도 해당 면접에서 실제로 확인할 가능성이 높은 새로운 관점의 질문을 포함하세요.
- 기본 질문, 경험 검증, 지원 동기, 역할 적합성, 약점·리스크 확인 순으로 자연스러운 면접 흐름을 만드세요.
- 답변에 따라 이어질 꼬리질문은 면접 진행 중 별도로 생성되므로, 여기서는 서로 중복되지 않는 핵심 질문만 만드세요.
- 표지, 제목, "예상 질문", 카테고리명, 목차는 질문으로 반환하지 마세요.
- 한국어 구어체 면접 질문 8~15개를 반환하세요.`;
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(analysisModel)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [
          { text: prompt },
          ...questionPdfs.flatMap((pdfData, index) => [
            { text: `[예상 질문 참고 PDF ${index + 1}: 문장 복사 금지, 평가 의도만 분석]` },
            { inlineData: { mimeType: 'application/pdf', data: pdfData } }
          ]),
          ...applicationPdfs.flatMap((pdfData, index) => [
            { text: `[지원서 PDF ${index + 1}: 실제 제출 자료]` },
            { inlineData: { mimeType: 'application/pdf', data: pdfData } }
          ])
        ] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: questionsSchema, maxOutputTokens: 6000, thinkingConfig: { thinkingLevel: 'minimal' } }
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      const retryDelay = payload?.error?.details?.find(detail => String(detail?.['@type']).includes('RetryInfo'))?.retryDelay || '';
      return json(res, response.status, { error: payload?.error?.message || '예상 질문 자료 분석에 실패했습니다.', retryDelay });
    }
    const text = payload?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('');
    const parsed = JSON.parse(text);
    json(res, 200, { briefing: parsed.briefing, questions: (parsed.questions || []).filter(Boolean) });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}

async function evaluate(req, res) {
  if (!process.env.GEMINI_API_KEY) return json(res, 503, { error: 'GEMINI_API_KEY가 설정되지 않았습니다.', demo: true });
  try {
    const data = await parseBody(req);
    const applicationPdfs = Array.isArray(data.applicationPdfData) ? data.applicationPdfData.filter(Boolean) : [];
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [
          { text: buildPrompt(data) },
          ...applicationPdfs.flatMap((pdfData, index) => [
            { text: `[지원서 PDF ${index + 1}]` },
            { inlineData: { mimeType: 'application/pdf', data: pdfData } }
          ])
        ] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: schema, maxOutputTokens: 2500, thinkingConfig: { thinkingLevel: 'minimal' } }
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      const retryDelay = payload?.error?.details?.find(detail => String(detail?.['@type']).includes('RetryInfo'))?.retryDelay || '';
      return json(res, response.status, { error: payload?.error?.message || 'Gemini 요청에 실패했습니다.', retryDelay });
    }
    const text = payload?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('');
    json(res, 200, JSON.parse(text));
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/api/questions' && req.method === 'POST') return extractQuestions(req, res);
  if (req.url === '/api/evaluate' && req.method === 'POST') return evaluate(req, res);
  if (req.url === '/api/status') return json(res, 200, { gemini: Boolean(process.env.GEMINI_API_KEY), model, analysisModel });
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const wanted = pathname === '/' ? 'index.html' : pathname.slice(1);
    const safe = normalize(wanted).replace(/^(\.\.(\/|\\|$))+/, '');
    const file = join(root, safe);
    if (!file.startsWith(root)) throw new Error('Invalid path');
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(content);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
});

server.listen(port, () => console.log(`Interview Room: http://localhost:${port}`));
