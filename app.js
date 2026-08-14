const $ = (s) => document.querySelector(s);
const views = { setup: $('#setupView'), interview: $('#interviewView'), result: $('#resultView') };
const state = { config: {}, questions: [], index: 0, history: [], seconds: 0, timer: null, stream: null, recognition: null, speaking: true, recording: false, pdfs: [], questionsPdfs: [], preAnalysis: null };
const targetPresets = {
  company: { name: '기업', organization: '지원 회사', organizationPlaceholder: '예: 카카오', role: '지원 직무', rolePlaceholder: '예: 프로덕트 디자이너', level: '경력 수준', levels: ['신입', '1~3년', '4~7년', '8년 이상'], context: '지원 내용 · 채용 공고 · 자기소개 요약', contextPlaceholder: '공고의 주요 요건, 지원 동기, 핵심 경험을 붙여 넣어 주세요.' },
  graduate: { name: '대학원', organization: '지원 대학원', organizationPlaceholder: '예: 서울대학교', role: '지원 학과 · 연구 분야', rolePlaceholder: '예: 컴퓨터공학과 · HCI', level: '지원 과정', levels: ['석사', '박사', '석박사 통합'], context: '연구계획 · 학업계획 · 자기소개', contextPlaceholder: '연구 관심 분야, 지원 동기, 연구 경험과 학업 계획을 입력해 주세요.' },
  club: { name: '동아리 · 학회', organization: '단체명', organizationPlaceholder: '예: 멋쟁이사자처럼', role: '지원 파트 · 활동 분야', rolePlaceholder: '예: 기획 · 개발', level: '지원 구분', levels: ['신규 지원', '운영진', '회장단'], context: '지원서 · 활동 경험 · 지원 동기', contextPlaceholder: '지원 동기, 관련 경험, 활동 목표를 입력해 주세요.' },
  public: { name: '공공기관', organization: '지원 기관', organizationPlaceholder: '예: 한국관광공사', role: '지원 직무', rolePlaceholder: '예: 일반행정', level: '지원 구분', levels: ['신입', '경력', '인턴'], context: '지원 내용 · 직무기술서 · 자기소개', contextPlaceholder: '직무기술서의 주요 요건과 자기소개서 내용을 입력해 주세요.' },
  other: { name: '기타', organization: '기관 · 모임명', organizationPlaceholder: '면접을 진행하는 곳', role: '지원 분야', rolePlaceholder: '지원하는 역할이나 분야', level: '지원 단계', levels: ['신규 지원', '경험자', '기타'], context: '지원 내용 · 관련 경험 · 자기소개', contextPlaceholder: '면접관이 알아야 할 지원 내용을 입력해 주세요.' }
};

function showView(name) { Object.entries(views).forEach(([key, el]) => el.classList.toggle('hidden', key !== name)); window.scrollTo(0, 0); }
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2600); }
function value(id) { return document.getElementById(id).value.trim(); }

function updateTargetFields() {
  const preset = targetPresets[value('targetType')];
  $('#organizationLabel').textContent = preset.organization; $('#company').placeholder = preset.organizationPlaceholder;
  $('#roleLabel').textContent = preset.role; $('#role').placeholder = preset.rolePlaceholder;
  $('#levelLabel').textContent = preset.level; $('#level').innerHTML = preset.levels.map(item => `<option>${item}</option>`).join('');
  $('#contextLabel').textContent = preset.context; $('#context').placeholder = preset.contextPlaceholder;
}

function addPdfFiles(files, target) {
  const incoming = [...(files || [])]; if (!incoming.length) return;
  if (incoming.some(file => file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf'))) return toast('PDF 파일만 첨부할 수 있어요.');
  if (incoming.some(file => file.size > 10 * 1024 * 1024)) return toast('각 PDF는 최대 10MB까지 첨부할 수 있어요.');
  const current = target === 'application' ? state.pdfs : state.questionsPdfs;
  const merged = [...current, ...incoming].filter((file, index, all) => all.findIndex(item => item.name === file.name && item.size === file.size) === index);
  if (merged.length > 5) return toast('PDF는 항목별로 최대 5개까지 첨부할 수 있어요.');
  if (merged.reduce((sum, file) => sum + file.size, 0) > 20 * 1024 * 1024) return toast('첨부 PDF의 총 용량은 항목별 20MB까지예요.');
  if (target === 'application') state.pdfs = merged; else state.questionsPdfs = merged;
  renderPdfFiles(target);
}

function renderPdfFiles(target) {
  const application = target === 'application'; const files = application ? state.pdfs : state.questionsPdfs;
  const drop = $(application ? '#fileDrop' : '#questionFileDrop'); const title = $(application ? '#fileTitle' : '#questionFileTitle'); const meta = $(application ? '#fileMeta' : '#questionFileMeta'); const remove = $(application ? '#removePdf' : '#removeQuestionsPdf');
  drop.classList.toggle('has-file', files.length > 0); remove.classList.toggle('hidden', !files.length);
  title.textContent = files.length ? files.map(file => file.name).join(', ') : application ? '지원서 PDF 첨부' : '예상 질문 PDF 첨부';
  meta.textContent = files.length ? `${files.length}개 · ${(files.reduce((sum, file) => sum + file.size, 0) / 1024 / 1024).toFixed(1)}MB · Gemini가 함께 분석합니다` : application ? '여러 파일 선택 가능 · 파일당 10MB · 최대 5개' : '선택 사항 · 여러 파일 선택 가능 · 최대 5개';
}

function clearPdf(event) { event?.preventDefault(); event?.stopPropagation(); state.pdfs = []; $('#applicationPdf').value = ''; renderPdfFiles('application'); }
function fileToBase64(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); }); }

function clearQuestionsPdf(event) { event?.preventDefault(); event?.stopPropagation(); state.questionsPdfs = []; $('#questionsPdf').value = ''; renderPdfFiles('questions'); }
function normalizeQuestion(question = '') {
  return String(question)
    .replace(/\r/g, '')
    .replace(/^\s*(?:[-•·*]|(?:Q\s*)?\d+[.)번:\-]?)\s*/i, '')
    .replace(/^질문\s*\d*\s*[.:：-]?\s*/i, '')
    .trim();
}

function isQuestionHeading(question = '') {
  const compact = normalizeQuestion(question).replace(/[\s.:：!?？!\-_()[\]【】]/g, '').toLowerCase();
  return !compact || compact.length < 2 || /^(예상질문|면접질문|질문목록|질문리스트|목차|interviewquestions?|questions?)$/i.test(compact);
}

function cleanQuestionList(questions) {
  return questions.map(normalizeQuestion).filter(question => !isQuestionHeading(question)).filter((question, index, all) => all.indexOf(question) === index);
}

function cleanQuestions(text) { return cleanQuestionList(text.split('\n')); }

async function generateQuestionsFromSources() {
  const questionPdfData = await Promise.all(state.questionsPdfs.map(fileToBase64));
  const applicationPdfData = await Promise.all(state.pdfs.map(fileToBase64));
  const response = await fetch('/api/questions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...state.config, questionPdfData, applicationPdfData }) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || '예상 질문 자료를 분석하지 못했습니다.');
  const originals = new Set(cleanQuestionList(state.config.expectedQuestions || []).map(question => question.replace(/\s/g, '').toLowerCase()));
  state.preAnalysis = payload.briefing || null;
  return cleanQuestionList(payload.questions || []).filter(question => !originals.has(question.replace(/\s/g, '').toLowerCase()));
}

function startCamera() {
  navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 } }, audio: false })
    .then(stream => { state.stream = stream; $('#camera').srcObject = stream; $('#cameraEmpty').classList.add('hidden'); $('#camCheck').textContent = '카메라 연결이 완료됐어요'; })
    .catch(() => { $('#cameraEmpty p').textContent = '카메라 권한을 허용해주세요'; toast('카메라 없이도 면접은 진행할 수 있어요.'); });
}

function speak(text) {
  if (!state.speaking || !('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text); utter.lang = 'ko-KR'; utter.rate = .96; utter.pitch = .95;
  utter.onstart = () => $('#speakingBars').classList.add('active');
  utter.onend = () => $('#speakingBars').classList.remove('active');
  speechSynthesis.speak(utter);
}

function setupRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return;
  const recognition = new Recognition(); recognition.lang = 'ko-KR'; recognition.interimResults = true; recognition.continuous = true;
  let finalText = '';
  recognition.onstart = () => { recognition.discardOnEnd = false; finalText = $('#transcript').value.trim(); if (finalText) finalText += ' '; state.recording = true; $('#recordButton').classList.add('recording'); $('#listeningBadge').classList.remove('hidden'); $('.record-copy b').textContent = '답변 중지'; };
  recognition.onresult = (event) => { let interim = ''; for (let i = event.resultIndex; i < event.results.length; i++) event.results[i].isFinal ? finalText += event.results[i][0].transcript + ' ' : interim += event.results[i][0].transcript; $('#transcript').value = finalText + interim; updateSubmit(); };
  recognition.onend = () => { state.recording = false; $('#recordButton').classList.remove('recording'); $('#listeningBadge').classList.add('hidden'); $('.record-copy b').textContent = '답변 시작'; finalText = recognition.discardOnEnd ? '' : $('#transcript').value.trim() + ' '; recognition.discardOnEnd = false; };
  recognition.onerror = (e) => { if (e.error !== 'aborted') toast('음성 인식을 사용할 수 없어 직접 입력 모드로 전환했어요.'); };
  recognition.resetTranscript = () => { recognition.discardOnEnd = true; finalText = ''; };
  state.recognition = recognition;
}

function renderQuestion() {
  while (state.index < state.questions.length && isQuestionHeading(state.questions[state.index])) state.index++;
  const question = normalizeQuestion(state.questions[state.index]) || '먼저 간단히 자기소개를 해주시겠어요?';
  state.questions[state.index] = question;
  $('#questionNumber').textContent = `QUESTION ${String(state.index + 1).padStart(2, '0')}`;
  $('#questionText').textContent = question; state.recognition?.resetTranscript(); $('#transcript').value = ''; updateSubmit(); setTimeout(() => speak(question), 350);
}

function updateSubmit() { $('#submitAnswer').disabled = $('#transcript').value.trim().length < 2; }
function updateTimer() { const m = Math.floor(state.seconds / 60), s = state.seconds % 60; $('#timer').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`; if (state.seconds-- <= 0) finishInterview(); }

function demoEvaluation(answer) {
  const concrete = /\d|프로젝트|결과|개선|성과|문제|고객/.test(answer); const long = answer.length > 90;
  return { score: (concrete ? 78 : 67) + (long ? 8 : 0), verdict: concrete ? '근거가 보이는 답변' : '조금 더 구체화가 필요해요', strengths: [long ? '답변의 맥락을 충분히 설명했습니다.' : '핵심을 짧게 전달했습니다.'], improvements: [concrete ? '성과에 본인의 기여도를 더 분명히 밝혀보세요.' : '상황·행동·결과를 수치와 함께 설명해보세요.'], feedback: concrete ? '경험과 결과가 연결되어 설득력이 있습니다. 본인이 내린 판단의 기준까지 덧붙이면 한층 선명해집니다.' : '방향은 좋지만 근거가 추상적입니다. 실제 사례 하나를 STAR 구조로 답하면 신뢰도가 올라갑니다.', improvedAnswer: '당시 목표와 제 역할을 먼저 설명하고, 제가 선택한 행동과 그 이유를 구체적으로 말씀드리겠습니다. 이후 측정 가능한 결과와 그 경험에서 배운 점을 지원 직무에 연결하겠습니다.', nextQuestion: '그 과정에서 본인이 직접 내린 가장 어려운 결정은 무엇이었고, 왜 그렇게 판단했나요?' };
}

async function getEvaluation(question, answer) {
  const body = { ...state.config, question, answer, history: state.history, preAnalysis: state.preAnalysis };
  try { const res = await fetch('/api/evaluate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); if (!res.ok) throw new Error(); return await res.json(); }
  catch { toast('Gemini 키가 없어 데모 평가로 진행합니다.'); return demoEvaluation(answer); }
}

$('#setupForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!value('context') && !state.pdfs.length) return toast('지원 내용을 입력하거나 지원서 PDF를 첨부해주세요.');
  const enterButton = $('#setupForm .primary-button'); enterButton.disabled = true; enterButton.querySelector('span').textContent = '면접 질문 준비 중…';
  const preset = targetPresets[value('targetType')];
  state.config = { targetType: preset.name, company: value('company'), role: value('role'), duration: value('duration'), interviewType: value('interviewType'), format: value('format'), level: value('level'), difficulty: value('difficulty'), context: value('context'), pdfNames: state.pdfs.map(file => file.name), questionsPdfNames: state.questionsPdfs.map(file => file.name), expectedQuestions: cleanQuestions(value('questions')) };
  let generatedQuestions = [];
  try { generatedQuestions = await generateQuestionsFromSources(); }
  catch (error) { toast(error.message); }
  state.questions = cleanQuestionList(generatedQuestions);
  if (!state.questions.length) state.questions = ['먼저 간단히 자기소개를 해주시겠어요?'];
  state.config.expectedQuestions = [...state.questions];
  state.index = 0; state.history = []; state.seconds = Number(state.config.duration) * 60;
  $('#typePill').textContent = state.config.targetType; $('#sessionTitle').textContent = `${state.config.company} · ${state.config.role}`; $('#interviewerRole').textContent = `${state.config.interviewType} Interviewer`; $('#topStatus').textContent = '면접 진행 중'; $('.live-dot').classList.add('active');
  showView('interview'); startCamera(); setupRecognition(); updateTimer(); state.timer = setInterval(updateTimer, 1000); renderQuestion();
  enterButton.disabled = false; enterButton.querySelector('span').textContent = '면접실 입장하기';
});

$('#recordButton').addEventListener('click', () => { if (!state.recognition) return toast('이 브라우저는 음성 인식을 지원하지 않아요. 직접 입력해주세요.'); state.recording ? state.recognition.stop() : state.recognition.start(); });
$('#transcript').addEventListener('input', updateSubmit);
$('#submitAnswer').addEventListener('click', async () => {
  if (state.recording) state.recognition.stop(); const answer = $('#transcript').value.trim(); if (!answer) return;
  state.recognition?.resetTranscript(); $('#transcript').value = '';
  const button = $('#submitAnswer'); button.disabled = true; button.textContent = '분석 중…';
  const question = state.questions[state.index]; const evaluation = await getEvaluation(question, answer);
  state.history.push({ question, answer, ...evaluation });
  state.index++; if (evaluation.nextQuestion && state.index < 8) state.questions.splice(state.index, 0, evaluation.nextQuestion);
  button.textContent = '답변 제출 →';
  if (state.seconds <= 0 || state.index >= Math.min(8, state.questions.length)) finishInterview(); else renderQuestion();
});

function finishInterview() {
  clearInterval(state.timer); speechSynthesis?.cancel(); state.recognition?.stop(); state.stream?.getTracks().forEach(t => t.stop());
  $('#topStatus').textContent = '면접 완료'; $('.live-dot').classList.remove('active');
  const avg = state.history.length ? Math.round(state.history.reduce((a, h) => a + Number(h.score || 0), 0) / state.history.length) : 0;
  $('#totalScore').textContent = avg; $('#scoreVerdict').textContent = avg >= 85 ? '준비된 지원자' : avg >= 70 ? '가능성이 선명한 답변' : '성장 포인트를 찾았어요';
  $('#scoreSummary').textContent = `${state.history.length}개 답변을 직무 관련성, 구체성, 논리성, 전달력 기준으로 분석했습니다.`;
  $('#resultSubtitle').textContent = `${state.config.company} ${state.config.role} · ${state.config.interviewType}`;
  $('#feedbackList').innerHTML = state.history.map((h, i) => `<article class="feedback-item"><header><h3>${i + 1}. ${escapeHtml(h.question)}</h3><span>${h.score}점</span></header><p>${escapeHtml(h.feedback)}</p><p><b>보완 포인트</b> · ${(h.improvements || []).map(escapeHtml).join(' · ')}</p><blockquote><b>이렇게 다듬어 보세요</b><br>${escapeHtml(h.improvedAnswer)}</blockquote></article>`).join('') || '<article class="feedback-item"><h3>제출된 답변이 없습니다.</h3><p>다음에는 한 질문에 답한 뒤 종료해보세요.</p></article>';
  showView('result');
}

function escapeHtml(text='') { const div = document.createElement('div'); div.textContent = text; return div.innerHTML; }
$('#finishButton').addEventListener('click', finishInterview);
$('#cameraToggle').addEventListener('click', () => { const track = state.stream?.getVideoTracks()[0]; if (!track) return; track.enabled = !track.enabled; $('#cameraToggle').textContent = track.enabled ? '◉' : '×'; });
$('#soundToggle').addEventListener('click', () => { state.speaking = !state.speaking; if (!state.speaking) speechSynthesis.cancel(); $('#soundToggle').style.opacity = state.speaking ? '1' : '.35'; toast(state.speaking ? '질문 음성을 켰어요.' : '질문 음성을 껐어요.'); });
$('#restartButton').addEventListener('click', () => location.reload());
$('#copyReport').addEventListener('click', async () => { const report = state.history.map((h,i)=>`${i+1}. ${h.question}\n답변: ${h.answer}\n점수: ${h.score}\n피드백: ${h.feedback}\n개선 답변: ${h.improvedAnswer}`).join('\n\n'); await navigator.clipboard.writeText(report); toast('면접 리포트를 복사했어요.'); });
$('#targetType').addEventListener('change', updateTargetFields);
$('#applicationPdf').addEventListener('change', e => { addPdfFiles(e.target.files, 'application'); e.target.value = ''; });
$('#removePdf').addEventListener('click', clearPdf);
$('#fileDrop').addEventListener('dragover', e => { e.preventDefault(); $('#fileDrop').classList.add('dragging'); });
$('#fileDrop').addEventListener('dragleave', () => $('#fileDrop').classList.remove('dragging'));
$('#fileDrop').addEventListener('drop', e => { e.preventDefault(); $('#fileDrop').classList.remove('dragging'); addPdfFiles(e.dataTransfer.files, 'application'); });
$('#questionsPdf').addEventListener('change', e => { addPdfFiles(e.target.files, 'questions'); e.target.value = ''; });
$('#removeQuestionsPdf').addEventListener('click', clearQuestionsPdf);
$('#questionFileDrop').addEventListener('dragover', e => { e.preventDefault(); $('#questionFileDrop').classList.add('dragging'); });
$('#questionFileDrop').addEventListener('dragleave', () => $('#questionFileDrop').classList.remove('dragging'));
$('#questionFileDrop').addEventListener('drop', e => { e.preventDefault(); $('#questionFileDrop').classList.remove('dragging'); addPdfFiles(e.dataTransfer.files, 'questions'); });
updateTargetFields();
