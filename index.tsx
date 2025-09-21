/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI, Type, Chat, GenerateContentResponse } from '@google/genai';
import { html, render } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import * as pdfjsLib from 'pdfjs-dist';

// Required for pdf.js to work in a module environment
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://esm.sh/pdfjs-dist@4.4.168/build/pdf.worker.mjs`;


// --- STATE MANAGEMENT ---
const state = {
  isLoading: false,
  analysis: null,
  error: null,
  activeClause: null,
  form: {
    documentContent: '',
    userRole: 'Tenant',
    audienceType: 'Layman',
    explanationLevel: 'Layman',
    explanationTone: 'Casual',
  },
  // New state for chat
  chat: null as Chat | null,
  chatHistory: [] as { role: 'user' | 'model', text: string }[],
  isChatLoading: false,
  chatError: null as string | null,
  currentQuestion: '',
};

// --- GEMINI API INTEGRATION ---
let ai;
try {
  ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
} catch (e) {
  console.error(e);
  state.error = 'Failed to initialize the Gemini API. Please ensure the API key is set correctly.';
}

const responseSchema = {
    type: Type.OBJECT,
    properties: {
        title: { type: Type.STRING },
        contract_type: { type: Type.STRING },
        summary: { type: Type.STRING },
        clauses: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    clause_number: { type: Type.INTEGER },
                    original_text: { type: Type.STRING },
                    simplified_text: { type: Type.STRING },
                    risk_level: { type: Type.STRING },
                    risk_description: { type: Type.STRING },
                },
                required: ['clause_number', 'simplified_text', 'risk_level', 'risk_description']
            }
        },
        critical_clauses: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    clause_number: { type: Type.INTEGER },
                    reason: { type: Type.STRING },
                },
                required: ['clause_number', 'reason']
            }
        },
        risk_levels: {
            type: Type.OBJECT,
            properties: {
                overall: { type: Type.STRING },
                explanation: { type: Type.STRING },
            },
            required: ['overall', 'explanation']
        },
        sentiment: { type: Type.STRING },
        intent: { type: Type.STRING },
        key_points: {
            type: Type.ARRAY,
            items: { type: Type.STRING }
        },
        audio_friendly_summary: { type: Type.STRING },
    },
    required: ['title', 'contract_type', 'summary', 'clauses', 'critical_clauses', 'risk_levels', 'key_points', 'audio_friendly_summary']
};


async function analyzeDocument() {
  if (!ai) {
    renderApp();
    return;
  }
  if (!state.form.documentContent.trim()) {
    state.error = 'Please paste or upload a document to analyze.';
    renderApp();
    return;
  }

  state.isLoading = true;
  state.analysis = null;
  state.error = null;
  state.chat = null;
  state.chatHistory = [];
  renderApp();

  const systemInstruction = `You are an expert legal document simplification assistant & risk analyst.
Your responsibilities:
 - First, perform a complete analysis of the provided document based on the user's context and return it as a single, valid JSON object that conforms to the provided schema. Do not add any other commentary.
 - After the initial analysis, you will act as a helpful assistant, answering follow-up questions about the document you just analyzed.`;

  const userPrompt = `Document content:
"""
${state.form.documentContent}
"""

Additional context:
 - User role: ${state.form.userRole}
 - Desired summary audience/type: ${state.form.audienceType}
 - Explanation complexity level: ${state.form.explanationLevel}
 - Explanation tone: ${state.form.explanationTone}
 - Required output format: JSON
`;

  try {
    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: userPrompt,
        config: {
            systemInstruction,
            responseMimeType: 'application/json',
            responseSchema: responseSchema,
        },
    });

    const jsonText = response.text.trim();
    state.analysis = JSON.parse(jsonText);

    // Initialize chat after successful analysis
    state.chat = ai.chats.create({
        model: 'gemini-2.5-flash',
        history: [
            { role: 'user', parts: [{ text: userPrompt }] },
            { role: 'model', parts: [{ text: `I have analyzed the document. Here is the summary in JSON format as requested:\n${jsonText}` }] }
        ],
        config: {
            systemInstruction: 'You are a helpful assistant answering questions about a legal document you have already analyzed. Be concise and refer to specific clauses when possible.'
        }
    });

  } catch (error) {
    console.error(error);
    state.error = `An error occurred during analysis: ${error.message}. Please try again.`;
  } finally {
    state.isLoading = false;
    renderApp();
  }
}


async function askFollowUpQuestion() {
    if (!state.chat || !state.currentQuestion.trim() || state.isChatLoading) {
        return;
    }

    const question = state.currentQuestion.trim();
    state.isChatLoading = true;
    state.chatError = null;
    state.chatHistory.push({ role: 'user', text: question });
    state.currentQuestion = '';
    renderApp();

    // After render, reset textarea height
    const textarea = document.querySelector('.chat-input') as HTMLTextAreaElement;
    if (textarea) {
        textarea.style.height = 'auto';
    }

    try {
        const response: GenerateContentResponse = await state.chat.sendMessage({ message: question });
        const answer = response.text;
        state.chatHistory.push({ role: 'model', text: answer });
    } catch (error) {
        console.error('Chat error:', error);
        state.chatError = `Sorry, an error occurred: ${error.message}`;
    } finally {
        state.isChatLoading = false;
        renderApp();
    }
}


// --- UI TEMPLATES & RENDERING ---

// --- CHAT HELPERS ---
function autoResizeTextarea(e: Event) {
    const textarea = e.target as HTMLTextAreaElement;
    textarea.style.height = 'auto'; // Reset height
    textarea.style.height = `${textarea.scrollHeight}px`;
}

function handleChatInputKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        askFollowUpQuestion();
    }
}

function scrollToChatBottom() {
    const chatHistory = document.querySelector('.chat-history');
    if (chatHistory) {
        chatHistory.scrollTop = chatHistory.scrollHeight;
    }
}


function renderRiskBadge(level) {
  const levelClass = level?.toLowerCase() || 'unknown';
  return html`<span class="risk-badge risk-${levelClass}">${level || 'N/A'}</span>`;
}

function renderChat() {
    if (!state.chat) return '';

    // Run this after the render to scroll down
    setTimeout(scrollToChatBottom, 0);

    return html`
    <div class="card">
        <h3>Follow-up Questions</h3>
        <div class="chat-container">
            <div class="chat-history">
                ${state.chatHistory.map(msg => html`
                    <div class="chat-message ${classMap({ user: msg.role === 'user', model: msg.role === 'model' })}">
                        <div class="avatar ${msg.role}"></div>
                        <div class="message-content">
                           <p>${msg.text}</p>
                        </div>
                    </div>
                `)}
                ${state.isChatLoading ? html`
                    <div class="chat-message model">
                         <div class="avatar model"></div>
                         <div class="message-content">
                            <div class="typing-indicator">
                                <span></span><span></span><span></span>
                            </div>
                         </div>
                    </div>
                ` : ''}
            </div>
            ${state.chatError ? html`<div class="error-message chat-error">${state.chatError}</div>` : ''}
            <form class="chat-form" @submit=${(e) => { e.preventDefault(); askFollowUpQuestion(); }}>
                <textarea
                    class="chat-input"
                    placeholder="Ask a question..."
                    .value=${state.currentQuestion}
                    @input=${(e) => {
                        state.currentQuestion = e.target.value;
                        autoResizeTextarea(e);
                    }}
                    @keydown=${handleChatInputKeydown}
                    ?disabled=${state.isChatLoading}
                    rows="1"
                ></textarea>
                <button type="submit" class="chat-send-btn" ?disabled=${!state.currentQuestion.trim() || state.isChatLoading}>
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M3.478 2.404a.75.75 0 0 0-.926.941l2.432 7.905H13.5a.75.75 0 0 1 0 1.5H4.984l-2.432 7.905a.75.75 0 0 0 .926.94 60.519 60.519 0 0 0 18.445-8.986.75.75 0 0 0 0-1.218A60.517 60.517 0 0 0 3.478 2.404Z" /></svg>
                </button>
            </form>
        </div>
    </div>
    `;
}

function renderAnalysis() {
  if (state.isLoading) {
    return html`
      <div class="loading-container">
        <div class="spinner"></div>
        <p>Analyzing document... This may take a moment.</p>
      </div>
    `;
  }
  if (state.error) {
    return html`<div class="error-message">${state.error}</div>`;
  }
  if (!state.analysis) {
    return html`<div class="placeholder">Analysis results will appear here.</div>`;
  }

  const {
    title, contract_type, summary, clauses, critical_clauses,
    risk_levels, key_points, audio_friendly_summary
  } = state.analysis;

  return html`
    <h2>${title}</h2>
    <div class="card contract-type">
        <strong>Contract Type:</strong> <span>${contract_type}</span>
    </div>

    <div class="card">
        <h3>Overall Risk Assessment</h3>
        <div class="overall-risk">
            ${renderRiskBadge(risk_levels.overall)}
            <p>${risk_levels.explanation}</p>
        </div>
    </div>
    
    <div class="card">
        <h3>Summary</h3>
        <p>${summary}</p>
        <button @click=${() => playAudio(audio_friendly_summary)} class="audio-button">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M7 15V9a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1Zm8-1.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm4 1.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"></path><path fill-rule="evenodd" d="M4 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h16a3 3 0 0 0 3-3V6a3 3 0 0 0-3-3H4Zm-1 3a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6Z" clip-rule="evenodd"></path></svg>
            Play Audio Summary
        </button>
    </div>

    <div class="card">
        <h3>Key Points</h3>
        <ul>
            ${key_points.map(point => html`<li>${point}</li>`)}
        </ul>
    </div>
    
    <div class="card">
        <h3>Critical Clauses</h3>
        ${critical_clauses.length > 0 ? html`
            <ul>
                ${critical_clauses.map(clause => html`
                    <li>
                        <strong>Clause ${clause.clause_number}:</strong>
                        <span>${clause.reason}</span>
                    </li>
                `)}
            </ul>
        ` : html`<p>No critical clauses were identified.</p>`}
    </div>

    <div class="card">
        <h3>Clause-by-Clause Analysis</h3>
        <div class="accordion">
            ${clauses.map(clause => html`
                <div class="accordion-item">
                    <button 
                        class="accordion-header" 
                        @click=${() => toggleClause(clause.clause_number)}
                        aria-expanded=${state.activeClause === clause.clause_number}
                    >
                        <span>Clause ${clause.clause_number}</span>
                        ${renderRiskBadge(clause.risk_level)}
                    </button>
                    <div class="accordion-content" ?hidden=${state.activeClause !== clause.clause_number}>
                        <p><strong>Simplified Explanation:</strong> ${clause.simplified_text}</p>
                        <p><strong>Risk:</strong> ${clause.risk_description}</p>
                        ${clause.original_text ? html`
                            <details>
                                <summary>Show Original Text</summary>
                                <p class="original-text">${clause.original_text}</p>
                            </details>
                        ` : ''}
                    </div>
                </div>
            `)}
        </div>
    </div>
    
    ${renderChat()}
  `;
}

const App = () => html`
  <header>
    <h1>Legal Document Analyzer</h1>
    <p>Simplify complex legal documents and identify risks with AI.</p>
  </header>
  <main>
    <div class="input-panel">
      <h2>Document & Context</h2>
      <form @submit=${(e) => { e.preventDefault(); analyzeDocument(); }}>
        <div class="form-group">
            <label for="fileUpload" class="file-upload-label">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width:1.25rem; height:1.25rem;"><path d="M11 15V6.414l-3.293 3.293a1 1 0 1 1-1.414-1.414l5-5a1 1 0 0 1 1.414 0l5 5a1 1 0 0 1-1.414 1.414L13 6.414V15a1 1 0 1 1-2 0ZM4 19a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v1a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-1Z"/></svg>
                Upload Document
            </label>
            <input 
                id="fileUpload" 
                type="file" 
                accept=".txt,text/plain,.pdf"
                style="display:none"
                @change=${handleFileUpload}
            >
            <span id="fileName" class="file-name"></span>
        </div>
        
        <div class="separator"><span>OR</span></div>
        
        <div class="form-group">
            <label for="documentContent">Paste Document Content</label>
            <textarea 
                id="documentContent" 
                rows="10"
                placeholder="Paste your full legal document here..."
                .value=${state.form.documentContent}
                @input=${(e) => state.form.documentContent = e.target.value}
                required
            ></textarea>
        </div>
        
        <h3>Additional Context</h3>
        <div class="form-grid">
            <div class="form-group">
                <label for="userRole">Your Role</label>
                <input type="text" id="userRole" .value=${state.form.userRole} @input=${(e) => state.form.userRole = e.target.value}>
            </div>
            <div class="form-group">
                <label for="audienceType">Summary Audience</label>
                <select id="audienceType" .value=${state.form.audienceType} @change=${(e) => state.form.audienceType = e.target.value}>
                    <option>Layman</option>
                    <option>Intermediate</option>
                    <option>Expert</option>
                </select>
            </div>
            <div class="form-group">
                <label for="explanationLevel">Explanation Complexity</label>
                <select id="explanationLevel" .value=${state.form.explanationLevel} @change=${(e) => state.form.explanationLevel = e.target.value}>
                    <option>Layman</option>
                    <option>Intermediate</option>
                    <option>Expert</option>
                </select>
            </div>
            <div class="form-group">
                <label for="explanationTone">Explanation Tone</label>
                <select id="explanationTone" .value=${state.form.explanationTone} @change=${(e) => state.form.explanationTone = e.target.value}>
                    <option>Casual</option>
                    <option>Formal</option>
                </select>
            </div>
        </div>
        
        <button type="submit" ?disabled=${state.isLoading}>
          ${state.isLoading ? 'Analyzing...' : 'Analyze Document'}
        </button>
      </form>
    </div>
    <div class="output-panel">
      ${renderAnalysis()}
    </div>
  </main>
`;

// --- EVENT HANDLERS & HELPERS ---
async function handleFileUpload(e: Event) {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    const fileNameDisplay = document.getElementById('fileName');

    if (!file) {
        if (fileNameDisplay) fileNameDisplay.textContent = '';
        return;
    }

    if (fileNameDisplay) fileNameDisplay.textContent = file.name;
    // Use the main isLoading state to give feedback during file parsing
    state.isLoading = true;
    state.error = null;
    state.form.documentContent = ''; // Clear previous content
    state.analysis = null; // Clear previous analysis
    renderApp();

    try {
        let textContent = '';
        if (file.type === 'application/pdf') {
            const arrayBuffer = await file.arrayBuffer();
            const pdf = await pdfjsLib.getDocument(arrayBuffer).promise;
            const pageTexts = [];
            for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                const content = await page.getTextContent();
                const pageText = content.items.map(item => ('str' in item ? item.str : '')).join(' ');
                pageTexts.push(pageText);
            }
            textContent = pageTexts.join('\n\n');
        } else if (file.type === 'text/plain') {
            textContent = await file.text();
        } else {
            throw new Error('Unsupported file type. Please upload a .txt or .pdf file.');
        }
        state.form.documentContent = textContent;
    } catch (error) {
        state.error = `Failed to process the uploaded file: ${error.message}`;
        console.error('File processing error:', error);
        if (fileNameDisplay) fileNameDisplay.textContent = 'Upload failed.';
    } finally {
        state.isLoading = false;
        // Re-render to show the content in the textarea or the error message
        renderApp();
    }
}

function toggleClause(clauseNumber) {
    state.activeClause = state.activeClause === clauseNumber ? null : clauseNumber;
    renderApp();
}

function playAudio(text) {
    if ('speechSynthesis' in window) {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'en-US';
        window.speechSynthesis.cancel(); // Cancel any previous speech
        window.speechSynthesis.speak(utterance);
    } else {
        alert('Sorry, your browser does not support text-to-speech.');
    }
}

function renderApp() {
  render(App(), document.getElementById('app'));
}

// --- INITIAL RENDER ---
renderApp();