/* ------------------------------------------------------------
   SQL Analyzer - Compare Core
   Versión mejorada con soporte completo para:
   - END/END;/GO/GO; en stored procedures y triggers
   - Índices (UNIQUE, CLUSTERED, NONCLUSTERED)
   - Constraints (PRIMARY KEY, FOREIGN KEY, UNIQUE, CHECK)
   - Script de migración completo
   ------------------------------------------------------------ */

document.getElementById('fileA').addEventListener('change', () => { });
document.getElementById('fileB').addEventListener('change', () => { });

document.getElementById('btnParse').addEventListener('click', async () => {
    const a = await readFileInput('fileA');
    const b = await readFileInput('fileB');
    if (!a && !b) { alert('Carga al menos un archivo A y B.'); return; }
    window.sqlA = a || '';
    window.sqlB = b || '';
    parseAndRenderAll(window.sqlA, window.sqlB);
});

document.getElementById('btnGenerate').addEventListener('click', () => {
    if (!window.schemaA) { alert('Analiza primero los archivos.'); return; }
    const script = generateSyncScript(window.schemaA, window.schemaB, window.dialectA, window.dialectB);
    downloadTextFile(script, 'sync_from_A_to_B.sql');
});

/* read file content or return empty string */
function readFileInput(id) {
    const input = document.getElementById(id);
    return new Promise(res => {
        if (!input || !input.files || input.files.length === 0) return res('');
        const fr = new FileReader();
        fr.onload = e => res(e.target.result);
        fr.readAsText(input.files[0]);
    });
}

/* ------------------------------------------------------------
   Parser heurístico mejorado - detecta objetos SQL correctamente
   ------------------------------------------------------------ */

/* Eliminar comentarios conservadoramente */
function stripComments(s) {
    if (!s) return '';
    // Eliminar comentarios /* ... */
    s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');
    // Eliminar comentarios de línea -- y #
    s = s.replace(/--.*$/gm, ' ');
    s = s.replace(/#.*$/gm, ' ');
    return s;
}

/* Normalizar GO como separador de lotes (SQL Server) 
   Retorna un array de lotes separados */
function splitBatches(sql) {
    if (!sql) return [''];
    // GO puede estar solo en una línea, con o sin punto y coma
    // Patrón: línea que contiene solo GO o GO; (con espacios opcionales)
    const batches = sql.split(/^\s*GO\s*;?\s*$/gim);
    return batches.filter(b => b.trim().length > 0);
}

/* find matching parenthesis position given open index */
function findMatchingParen(s, openIndex) {
    if (!s || openIndex < 0 || s[openIndex] !== '(') return -1;
    let depth = 0;
    let inSQ = false, inDQ = false;
    for (let i = openIndex; i < s.length; i++) {
        const c = s[i];
        // Manejo de strings
        if (!inDQ && c === "'" && (i === 0 || s[i-1] !== '\\')) { inSQ = !inSQ; continue; }
        if (!inSQ && c === '"' && (i === 0 || s[i-1] !== '\\')) { inDQ = !inDQ; continue; }
        if (inSQ || inDQ) continue;
        
        if (c === '(') depth++;
        else if (c === ')') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

/* Encontrar el END correspondiente contando BEGIN/END anidados */
function findMatchingEnd(sql, startIndex) {
    let depth = 0;
    let i = startIndex;
    const len = sql.length;
    let inSQ = false, inDQ = false;
    
    // Patrones para BEGIN y END (case insensitive)
    const beginRegex = /\bBEGIN\b/gi;
    const endRegex = /\bEND\b/gi;
    
    while (i < len) {
        const c = sql[i];
        
        // Manejo de strings - saltar contenido de strings
        if (!inDQ && c === "'" && (i === 0 || sql[i-1] !== '\\')) { 
            inSQ = !inSQ; 
            i++; 
            continue; 
        }
        if (!inSQ && c === '"' && (i === 0 || sql[i-1] !== '\\')) { 
            inDQ = !inDQ; 
            i++; 
            continue; 
        }
        if (inSQ || inDQ) { 
            i++; 
            continue; 
        }
        
        // Buscar BEGIN
        if (sql.substring(i, i + 5).toUpperCase() === 'BEGIN') {
            // Verificar que sea una palabra completa
            const before = i > 0 ? sql[i-1] : ' ';
            const after = i + 5 < len ? sql[i + 5] : ' ';
            if (/\W/.test(before) && /\W/.test(after)) {
                depth++;
                i += 5;
                continue;
            }
        }
        
        // Buscar END
        if (sql.substring(i, i + 3).toUpperCase() === 'END') {
            const before = i > 0 ? sql[i-1] : ' ';
            const after = i + 3 < len ? sql[i + 3] : ' ';
            // Verificar que sea palabra completa y NO sea ENDIF, ENDWHILE, etc.
            if (/\W/.test(before) && (/\W/.test(after) || after === ';')) {
                // Verificar que no sea parte de otra palabra como ENDIF
                const nextChar = sql.substring(i + 3, i + 4).toUpperCase();
                if (!/[A-Z_]/.test(nextChar)) {
                    depth--;
                    if (depth === 0) {
                        // Encontrar el final del END (puede tener ; o espacio después)
                        let endPos = i + 3;
                        // Saltar espacios
                        while (endPos < len && /\s/.test(sql[endPos])) endPos++;
                        // Si hay punto y coma, incluirlo
                        if (endPos < len && sql[endPos] === ';') endPos++;
                        return endPos;
                    }
                    i += 3;
                    continue;
                }
            }
        }
        i++;
    }
    return -1; // No se encontró END correspondiente
}

/* Encontrar el final de un statement considerando GO, END, y ; */
function findStatementEnd(sql, startIndex, objectType) {
    const normalizedSql = sql;
    
    // Para procedures, functions, triggers: buscar END correspondiente
    if (['procedure', 'function', 'trigger'].includes(objectType.toLowerCase())) {
        // Primero buscar si hay un BEGIN
        const searchArea = sql.substring(startIndex);
        const beginMatch = searchArea.match(/\bBEGIN\b/i);
        
        if (beginMatch) {
            const beginPos = startIndex + beginMatch.index;
            const endPos = findMatchingEnd(sql, beginPos);
            if (endPos > 0) {
                // Buscar GO después del END
                const afterEnd = sql.substring(endPos);
                const goMatch = afterEnd.match(/^\s*GO\s*;?\s*/im);
                if (goMatch) {
                    return endPos + goMatch[0].length;
                }
                return endPos;
            }
        }
        
        // Fallback: buscar GO o punto y coma
        const goMatch = searchArea.match(/^\s*GO\s*;?\s*$/im);
        if (goMatch) {
            return startIndex + goMatch.index + goMatch[0].length;
        }
    }
    
    // Para views, indexes: buscar ; o GO
    const searchArea = sql.substring(startIndex);
    
    // Buscar GO en línea separada
    const goMatch = searchArea.match(/^.*?\n\s*GO\s*;?\s*$/im);
    if (goMatch) {
        return startIndex + goMatch[0].length;
    }
    
    // Buscar punto y coma
    let depth = 0;
    let inSQ = false, inDQ = false;
    for (let i = startIndex; i < sql.length; i++) {
        const c = sql[i];
        if (!inDQ && c === "'") { inSQ = !inSQ; continue; }
        if (!inSQ && c === '"') { inDQ = !inDQ; continue; }
        if (inSQ || inDQ) continue;
        if (c === '(') depth++;
        if (c === ')') depth--;
        if (c === ';' && depth === 0) return i + 1;
    }
    
    return sql.length;
}

/* split by top-level commas (not inside parentheses or quotes) */
function splitTopLevelCommas(s) {
    const parts = [];
    if (s == null) return parts;
    let cur = '', depth = 0;
    let inSQ = false, inDQ = false, inBT = false, inBR = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (!inDQ && !inBT && !inBR && c === "'") { inSQ = !inSQ; cur += c; continue; }
        if (!inSQ && !inBT && !inBR && c === '"') { inDQ = !inDQ; cur += c; continue; }
        if (!inSQ && !inDQ && !inBR && c === '`') { inBT = !inBT; cur += c; continue; }
        if (!inSQ && !inDQ && !inBT && c === '[') { inBR = true; cur += c; continue; }
        if (inBR && c === ']') { inBR = false; cur += c; continue; }

        if (inSQ || inDQ || inBT || inBR) { cur += c; continue; }
        if (c === '(') { depth++; cur += c; continue; }
        if (c === ')') { if (depth > 0) depth--; cur += c; continue; }
        if (c === ',' && depth === 0) { parts.push(cur); cur = ''; } else { cur += c; }
    }
    if (cur.length > 0) parts.push(cur);
    return parts;
}

/* parse CREATE TABLE blocks into {name, columns: {col: def}, constraints: [], raw} */
function parseTables(sql) {
    const out = {};
    const s = stripComments(sql);
    const lower = s.toLowerCase();
    let idx = 0;
    
    while (true) {
        const start = lower.indexOf('create table', idx);
        if (start < 0) break;
        
        // find '(' after start
        const openParen = s.indexOf('(', start);
        if (openParen < 0) { idx = start + 12; continue; }
        
        const header = s.substring(start, openParen);
        const closeParen = findMatchingParen(s, openParen);
        if (closeParen < 0) { idx = openParen + 1; continue; }
        
        // Buscar el final del statement (puede haber opciones después del paréntesis)
        let end = closeParen + 1;
        // Buscar ; o GO después del paréntesis de cierre
        const afterClose = s.substring(closeParen + 1);
        const semiMatch = afterClose.match(/^[^;]*;/);
        const goMatch = afterClose.match(/^[^;]*?\n\s*GO\s*;?\s*/im);
        
        if (semiMatch && (!goMatch || semiMatch.index < goMatch.index)) {
            end = closeParen + 1 + semiMatch[0].length;
        } else if (goMatch) {
            end = closeParen + 1 + goMatch[0].length;
        }
        
        const stmt = s.substring(start, end).trim();
        
        // extract table name from header
        let name = header.replace(/create\s+table/i, '').replace(/if\s+not\s+exists/i, '').trim();
        name = name.split(/\s+/)[0].replace(/["`\[\]]/g, '');
        name = (name.indexOf('.') >= 0) ? name.split('.').pop() : name;
        name = name.trim();
        
        // parse cols block
        const colsBlock = s.substring(openParen + 1, closeParen);
        const defs = splitTopLevelCommas(colsBlock);
        const columns = {};
        const constraints = [];
        
        defs.forEach(d => {
            const dd = d.trim();
            if (!dd) return;
            const low = dd.toLowerCase();
            
            // Detectar constraints de tabla
            if (low.startsWith('constraint') || low.startsWith('primary key') || 
                low.startsWith('unique') || low.startsWith('foreign key') || 
                low.startsWith('check') || low.startsWith('index') || low.startsWith('key')) {
                constraints.push(parseConstraint(dd));
                return;
            }
            
            // column pattern: name + rest
            const m = dd.match(/^\s*([`"\[\]\w]+)\s+(.+)$/s);
            if (m) {
                let colName = m[1].replace(/["`\[\]]/g, '');
                let typeRest = m[2].trim().replace(/\s+/g, ' ');
                const colDef = {
                    raw: dd,
                    type: extractType(typeRest),
                    nullable: !low.includes('not null'),
                    primaryKey: low.includes('primary key'),
                    unique: low.includes('unique'),
                    defaultValue: extractDefault(typeRest),
                    identity: low.includes('identity') || low.includes('auto_increment')
                };
                columns[colName] = colDef;
            }
        });
        
        out[name] = { name, columns, constraints, raw: stmt.trim() };
        idx = end;
    }
    return out;
}

/* Parsear constraint de tabla */
function parseConstraint(def) {
    const low = def.toLowerCase();
    let type = 'unknown';
    let name = null;
    let columns = [];
    let references = null;
    
    // Extraer nombre si tiene CONSTRAINT nombre
    const constraintMatch = def.match(/constraint\s+([`"\[\]\w]+)/i);
    if (constraintMatch) {
        name = constraintMatch[1].replace(/["`\[\]]/g, '');
    }
    
    if (low.includes('primary key')) {
        type = 'PRIMARY KEY';
        const colMatch = def.match(/primary\s+key\s*\(([^)]+)\)/i);
        if (colMatch) columns = colMatch[1].split(',').map(c => c.trim().replace(/["`\[\]]/g, ''));
    } else if (low.includes('foreign key')) {
        type = 'FOREIGN KEY';
        const fkMatch = def.match(/foreign\s+key\s*\(([^)]+)\)\s*references\s+([`"\[\]\w.]+)\s*\(([^)]+)\)/i);
        if (fkMatch) {
            columns = fkMatch[1].split(',').map(c => c.trim().replace(/["`\[\]]/g, ''));
            references = {
                table: fkMatch[2].replace(/["`\[\]]/g, ''),
                columns: fkMatch[3].split(',').map(c => c.trim().replace(/["`\[\]]/g, ''))
            };
        }
    } else if (low.includes('unique')) {
        type = 'UNIQUE';
        const uniqMatch = def.match(/unique\s*(?:key|index)?\s*(?:[`"\[\]\w]+)?\s*\(([^)]+)\)/i);
        if (uniqMatch) columns = uniqMatch[1].split(',').map(c => c.trim().replace(/["`\[\]]/g, ''));
    } else if (low.includes('check')) {
        type = 'CHECK';
    } else if (low.startsWith('index') || low.startsWith('key')) {
        type = 'INDEX';
        const idxMatch = def.match(/(?:index|key)\s+([`"\[\]\w]+)?\s*\(([^)]+)\)/i);
        if (idxMatch) {
            if (idxMatch[1]) name = idxMatch[1].replace(/["`\[\]]/g, '');
            columns = idxMatch[2].split(',').map(c => c.trim().replace(/["`\[\]]/g, ''));
        }
    }
    
    return { type, name, columns, references, raw: def };
}

/* extract basic data type token from a column definition */
function extractType(typeRest) {
    if (!typeRest) return '';
    // capture token like VARCHAR(50) or NUMBER(10,2) or NVARCHAR2(100) or INT
    const m = typeRest.match(/^[\w]+(?:\s*\([^\)]*\))?/i);
    if (m) return m[0].replace(/\s+/g, ' ').toUpperCase();
    return typeRest.split(/\s+/)[0].toUpperCase();
}

/* extract default value from column definition */
function extractDefault(typeRest) {
    if (!typeRest) return null;
    const match = typeRest.match(/default\s+([^,\s]+|'[^']*'|"[^"]*")/i);
    return match ? match[1] : null;
}

/* parse procedures, functions, views, triggers - MEJORADO */
function parseOtherObjects(sql) {
    const s = stripComments(sql);
    const out = { procedures: {}, functions: {}, views: {}, triggers: {}, indexes: {} };

    // Parsear procedures
    const procRegex = /create\s+(or\s+replace\s+)?(procedure|proc)\s+/gi;
    let m;
    while ((m = procRegex.exec(s)) !== null) {
        const start = m.index;
        const endIdx = findStatementEnd(s, start, 'procedure');
        const stmt = s.substring(start, endIdx).trim();
        // Limpiar GO al final si existe
        const cleanStmt = stmt.replace(/\s*GO\s*;?\s*$/i, '').trim();
        const name = extractObjectNameFromHeader(cleanStmt, 'proc(?:edure)?');
        out.procedures[name] = cleanStmt;
    }

    // Parsear functions
    const funcRegex = /create\s+(or\s+replace\s+)?function\s+/gi;
    while ((m = funcRegex.exec(s)) !== null) {
        const start = m.index;
        const endIdx = findStatementEnd(s, start, 'function');
        const stmt = s.substring(start, endIdx).trim();
        const cleanStmt = stmt.replace(/\s*GO\s*;?\s*$/i, '').trim();
        const name = extractObjectNameFromHeader(cleanStmt, 'function');
        out.functions[name] = cleanStmt;
    }

    // Parsear views
    const viewRegex = /create\s+(or\s+replace\s+)?view\s+/gi;
    while ((m = viewRegex.exec(s)) !== null) {
        const start = m.index;
        const endIdx = findStatementEnd(s, start, 'view');
        const stmt = s.substring(start, endIdx).trim();
        const cleanStmt = stmt.replace(/\s*GO\s*;?\s*$/i, '').trim();
        const name = extractObjectNameFromHeader(cleanStmt, 'view');
        out.views[name] = cleanStmt;
    }

    // Parsear triggers - MEJORADO para detectar END correctamente
    const trigRegex = /create\s+(or\s+replace\s+)?trigger\s+/gi;
    while ((m = trigRegex.exec(s)) !== null) {
        const start = m.index;
        const endIdx = findStatementEnd(s, start, 'trigger');
        const stmt = s.substring(start, endIdx).trim();
        const cleanStmt = stmt.replace(/\s*GO\s*;?\s*$/i, '').trim();
        const name = extractObjectNameFromHeader(cleanStmt, 'trigger');
        out.triggers[name] = cleanStmt;
    }

    // Parsear indexes - MEJORADO para detectar todos los tipos
    const idxRegex = /create\s+(unique\s+)?(clustered\s+|nonclustered\s+)?index\s+/gi;
    while ((m = idxRegex.exec(s)) !== null) {
        const start = m.index;
        const endIdx = findStatementEnd(s, start, 'index');
        const stmt = s.substring(start, endIdx).trim();
        const cleanStmt = stmt.replace(/\s*GO\s*;?\s*$/i, '').trim();
        const name = extractIndexName(cleanStmt);
        if (name) {
            out.indexes[name] = {
                raw: cleanStmt,
                unique: /\bunique\b/i.test(cleanStmt),
                clustered: /\bclustered\b/i.test(cleanStmt),
                nonclustered: /\bnonclustered\b/i.test(cleanStmt),
                table: extractIndexTable(cleanStmt),
                columns: extractIndexColumns(cleanStmt)
            };
        }
    }

    return out;
}

/* helper to extract object name from statement header */
function extractObjectNameFromHeader(stmt, kind) {
    const re = new RegExp('create\\s+(?:or\\s+replace\\s+)?(?:' + kind + ')\\s+(?:if\\s+not\\s+exists\\s+)?([\\w\\.\"`\\[\\]]+)', 'i');
    const m = stmt.match(re);
    if (m && m[1]) {
        let name = m[1].replace(/["`\[\]]/g, '');
        if (name.indexOf('.') >= 0) name = name.split('.').pop();
        return name;
    }
    // fallback: primer token después de la palabra clave
    const words = stmt.split(/\s+/);
    for (let i = 0; i < words.length - 1; i++) {
        if (words[i].toLowerCase().match(/procedure|proc|function|view|trigger/)) {
            return words[i + 1].replace(/["`\[\]()]/g, '').split('.').pop();
        }
    }
    return 'unknown_' + Math.random().toString(36).slice(2, 8);
}

/* Extraer nombre del índice */
function extractIndexName(stmt) {
    const match = stmt.match(/create\s+(?:unique\s+)?(?:clustered\s+|nonclustered\s+)?index\s+([`"\[\]\w.]+)/i);
    if (match) {
        let name = match[1].replace(/["`\[\]]/g, '');
        if (name.indexOf('.') >= 0) name = name.split('.').pop();
        return name;
    }
    return null;
}

/* Extraer tabla del índice */
function extractIndexTable(stmt) {
    const match = stmt.match(/\bon\s+([`"\[\]\w.]+)/i);
    if (match) {
        let table = match[1].replace(/["`\[\]]/g, '');
        if (table.indexOf('.') >= 0) table = table.split('.').pop();
        return table;
    }
    return null;
}

/* Extraer columnas del índice */
function extractIndexColumns(stmt) {
    const match = stmt.match(/\bon\s+[`"\[\]\w.]+\s*\(([^)]+)\)/i);
    if (match) {
        return match[1].split(',').map(c => {
            // Eliminar ASC, DESC y espacios
            return c.trim().replace(/\s+(asc|desc)$/i, '').replace(/["`\[\]]/g, '');
        });
    }
    return [];
}

/* detect dialect: checks for tokens typical of Oracle or SQL Server */
function detectDialect(sql) {
    if (!sql) return 'unknown';
    const s = sql.toLowerCase();
    const oracleTokens = ['varchar2', 'number(', 'sysdate', 'dual', 'nvarchar2', 'rownum', 'to_char(', 'nvl(', 'decode('];
    const mssqlTokens = ['identity', 'varchar(max)', 'getdate()', 'nvarchar(', 'select top', 'isnull(', 'dbo.', 'nolock', 'with (nolock)'];
    
    for (const t of oracleTokens) if (s.includes(t)) return 'oracle';
    for (const t of mssqlTokens) if (s.includes(t)) return 'sqlserver';
    
    // Verificar GO como separador de lotes (SQL Server)
    if (/^\s*go\s*$/im.test(s)) return 'sqlserver';
    
    // Si tiene CREATE OR REPLACE es Oracle
    if (s.includes('create or replace')) return 'oracle';
    
    return 'sqlserver'; // default
}

/* parse INSERT INTO statements */
function parseInserts(sql) {
    const inserts = {};
    const s = stripComments(sql);

    // Captura INSERT INTO <tabla> (...) VALUES (...) [,(...)] [;]
    const regex = /insert\s+into\s+([`"\[\]\w\.]+)\s*(\([^\)]*\))?\s*values\s*\(([^\)]*?)\)(\s*,\s*\([^\)]*?\))*\s*;?/gim;

    let m;
    while ((m = regex.exec(s)) !== null) {
        let table = m[1].replace(/["`\[\]]/g, '');
        if (table.indexOf('.') >= 0) table = table.split('.').pop();

        // Extraer columnas (opcional)
        const cols = m[2]
            ? m[2].replace(/[()\s]/g, '').split(',').filter(c => c.length > 0)
            : [];

        // Extraer todos los grupos VALUES(...)
        const valuesBlock = m[0].substring(m[0].toLowerCase().indexOf('values') + 6);
        const valueMatches = Array.from(valuesBlock.matchAll(/\(([^)]*?)\)/g));

        valueMatches.forEach(vMatch => {
            const valsRaw = vMatch[1].trim();
            const vals = splitTopLevelCommas(valsRaw).map(v => v.trim());

            if (!inserts[table]) inserts[table] = [];
            inserts[table].push({
                table,
                cols,
                vals,
                raw: `INSERT INTO ${table}${cols.length ? ' (' + cols.join(', ') + ')' : ''} VALUES (${vals.join(', ')});`
            });
        });
    }

    return inserts;
}

/* build overall schema object */
function buildSchema(sql) {
    const tables = parseTables(sql);
    const others = parseOtherObjects(sql);
    const inserts = parseInserts(sql);
    return { tables, inserts, ...others };
}

/* ------------------------------------------------------------
   Comparison + Render UI (tree explorer)
   ------------------------------------------------------------ */

function parseAndRenderAll(sqlA, sqlB) {
    window.dialectA = detectDialect(sqlA);
    window.dialectB = detectDialect(sqlB);
    document.getElementById('detectedA').textContent = 'Dialect A: ' + window.dialectA.toUpperCase();
    document.getElementById('detectedB').textContent = 'Dialect B: ' + window.dialectB.toUpperCase();

    window.schemaA = buildSchema(sqlA || '');
    window.schemaB = buildSchema(sqlB || '');

    // summaries
    document.getElementById('summaryA').textContent = summarizeSchema(window.schemaA);
    document.getElementById('summaryB').textContent = summarizeSchema(window.schemaB);

    renderPanel('panelA', window.schemaA, window.schemaB, 'A');
    renderPanel('panelB', window.schemaB, window.schemaA, 'B');
    // clear preview
    document.getElementById('preview').textContent = 'Seleccione un nodo para ver la definición aquí.';
}

/* quick summary string */
function summarizeSchema(schema) {
    const t = Object.keys(schema.tables || {}).length;
    const p = Object.keys(schema.procedures || {}).length;
    const f = Object.keys(schema.functions || {}).length;
    const v = Object.keys(schema.views || {}).length;
    const tr = Object.keys(schema.triggers || {}).length;
    const idx = Object.keys(schema.indexes || {}).length;
    // Contar total de inserts (suma de todos los arrays por tabla)
    const ins = Object.values(schema.inserts || {}).reduce((sum, arr) => sum + arr.length, 0);
    return `${t} tablas · ${p} procs · ${f} funcs · ${v} vistas · ${tr} triggers · ${idx} índices · ${ins} inserts`;
}

/* decide node status vs otherSchema */
function compareObject(kind, name, thisObj, otherSchema) {
    if (!otherSchema) return 'missing';
    
    if (kind === 'table') {
        if (!otherSchema.tables || !otherSchema.tables[name]) return 'missing';
        const colsA = thisObj.columns || {};
        const colsB = otherSchema.tables[name].columns || {};
        for (const c of Object.keys(colsA)) {
            if (!colsB[c]) return 'different';
            if (!typesEquivalent(colsA[c].type, colsB[c].type)) return 'different';
        }
        return 'same';
    } else if (kind === 'insert') {
        const oth = otherSchema.inserts || {};
        if (!oth[name]) return 'missing';
        const rawsA = thisObj.map(x => normalizeWhitespace(x.raw));
        const rawsB = (oth[name] || []).map(x => normalizeWhitespace(x.raw));
        for (const ra of rawsA) if (!rawsB.includes(ra)) return 'different';
        return 'same';
    } else if (kind === 'index' || kind === 'indexe') {
        const oth = otherSchema.indexes || {};
        if (!oth[name]) return 'missing';
        // Comparar definición del índice
        const a = normalizeWhitespace(thisObj.raw || thisObj);
        const b = normalizeWhitespace(oth[name].raw || oth[name]);
        return (a === b) ? 'same' : 'different';
    } else {
        // procedures/functions/views/triggers
        const mapName = kind + (kind.endsWith('s') ? '' : 's');
        const oth = otherSchema[mapName];
        if (!oth || !oth[name]) return 'missing';
        const a = normalizeWhitespace(typeof thisObj === 'string' ? thisObj : thisObj.raw);
        const b = normalizeWhitespace(typeof oth[name] === 'string' ? oth[name] : oth[name].raw);
        return (a === b) ? 'same' : 'different';
    }
}

/* normalize whitespace for textual comparison */
function normalizeWhitespace(s) {
    if (!s) return '';
    return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/* tiny type equivalence comparator */
function typesEquivalent(a, b) {
    if (!a || !b) return false;
    const na = a.replace(/\s+/g, '').toUpperCase();
    const nb = b.replace(/\s+/g, '').toUpperCase();
    if (na === nb) return true;
    // equivalences
    if ((na.startsWith('VARCHAR') && nb.startsWith('VARCHAR2')) || 
        (na.startsWith('VARCHAR2') && nb.startsWith('VARCHAR'))) return true;
    if ((na.startsWith('NVARCHAR') && nb.startsWith('NVARCHAR2')) || 
        (na.startsWith('NVARCHAR2') && nb.startsWith('NVARCHAR'))) return true;
    if ((na === 'INT' && nb === 'NUMBER') || (na === 'NUMBER' && nb === 'INT')) return true;
    if ((na === 'INTEGER' && nb === 'INT') || (na === 'INT' && nb === 'INTEGER')) return true;
    if ((na === 'BIGINT' && nb.startsWith('NUMBER')) || (nb === 'BIGINT' && na.startsWith('NUMBER'))) return true;
    if ((na === 'DATE' && nb.startsWith('TIMESTAMP')) || (nb === 'DATE' && na.startsWith('TIMESTAMP'))) return true;
    if ((na === 'DATETIME' && nb.startsWith('TIMESTAMP')) || (nb === 'DATETIME' && na.startsWith('TIMESTAMP'))) return true;
    if ((na === 'BIT' && nb === 'BOOLEAN') || (na === 'BOOLEAN' && nb === 'BIT')) return true;
    if ((na === 'TEXT' && nb.startsWith('CLOB')) || (na.startsWith('CLOB') && nb === 'TEXT')) return true;
    if ((na === 'IMAGE' && nb.startsWith('BLOB')) || (na.startsWith('BLOB') && nb === 'IMAGE')) return true;
    return false;
}

/* render a whole schema into panelId */
function renderPanel(panelId, schema, otherSchema, sideLabel) {
    const root = document.getElementById(panelId);
    root.innerHTML = '';

    const ul = document.createElement('ul');
    ul.className = 'tree';

    // Tables folder node
    const liFolder = document.createElement('li');
    liFolder.innerHTML = `<div class="node"><span class="collapser">[+]</span><div class="badge normal">Tables</div></div>`;
    const innerUL = document.createElement('ul');
    innerUL.style.display = 'none';
    innerUL.className = 'tree ml-4';

    const namesA = Object.keys(schema.tables || {});
    const namesB = Object.keys((otherSchema && otherSchema.tables) || {});
    const unionNamesSet = new Set([...namesA, ...namesB]);
    const tableNames = Array.from(unionNamesSet).sort((x, y) => x.localeCompare(y));

    tableNames.forEach(tn => {
        const t = schema.tables && schema.tables[tn];
        const otherT = otherSchema && otherSchema.tables && otherSchema.tables[tn];
        let status;
        if (!t) {
            status = 'missing';
        } else {
            status = compareObject('table', tn, t, otherSchema);
        }

        let badgeClass;
        if (sideLabel === 'A') {
            badgeClass = (status === 'missing' || status === 'different') ? 'blue' : 'normal';
        } else {
            badgeClass = (status === 'missing' || status === 'different') ? 'red' : 'normal';
        }

        const li = document.createElement('li');
        li.innerHTML = `
          <div class="node" data-kind="table" data-name="${tn}" data-side="${sideLabel}">
              <span class="collapser">[+]</span>
              <div class="badge ${badgeClass}">${tn}</div>
              <div style="margin-left:auto;font-size:12px;color:#555">${(t && Object.keys(t.columns||{}).length) || (otherT && Object.keys(otherT.columns||{}).length) || 0} cols</div>
          </div>`;

        const colsUL = document.createElement('ul');
        colsUL.className = 'tree ml-6';
        colsUL.style.display = 'none';

        const colsThis = (t && t.columns) || {};
        const colsOther = (otherT && otherT.columns) || {};
        const colUnion = new Set([...Object.keys(colsThis), ...Object.keys(colsOther)]);
        const colNames = Array.from(colUnion).sort((a,b)=>a.localeCompare(b));

        colNames.forEach(cn => {
            const col = colsThis[cn];
            const otherCol = colsOther[cn];
            let colStatus;
            if (!col) {
                colStatus = 'missing';
            } else {
                colStatus = compareColumn(tn, cn, col, otherSchema);
            }

            let colBadge;
            if (sideLabel === 'A') {
                colBadge = (colStatus === 'missing' || colStatus === 'different') ? 'blue' : 'normal';
            } else {
                colBadge = (colStatus === 'missing' || colStatus === 'different') ? 'red' : 'normal';
            }

            const dispType = (col && col.type) ? col.type : (otherCol && otherCol.type) ? otherCol.type : '';

            const liCol = document.createElement('li');
            liCol.innerHTML = `
              <div class="node" data-kind="column" data-table="${tn}" data-name="${cn}" data-side="${sideLabel}">
                <span class="collapser"></span>
                <div style="display:flex;align-items:center;gap:8px">
                  <div class="badge ${colBadge}">
                    <span class="col-name">${cn}</span>
                    <span class="col-type">${dispType || ''}</span>
                  </div>
                </div>
              </div>`;
            colsUL.appendChild(liCol);
        });

        li.appendChild(colsUL);
        innerUL.appendChild(li);
    });

    liFolder.appendChild(innerUL);
    ul.appendChild(liFolder);

    // Procedures / Functions / Views / Triggers / Indexes
    const procFolder = renderSimpleFolder('Procedures', schema.procedures || {}, otherSchema, 'procedures', sideLabel);
    const funcFolder = renderSimpleFolder('Functions', schema.functions || {}, otherSchema, 'functions', sideLabel);
    const viewFolder = renderSimpleFolder('Views', schema.views || {}, otherSchema, 'views', sideLabel);
    const trigFolder = renderSimpleFolder('Triggers', schema.triggers || {}, otherSchema, 'triggers', sideLabel);
    const idxFolder = renderIndexFolder('Indexes', schema.indexes || {}, otherSchema, sideLabel);
    const insertsFolder = renderSimpleFolder('Inserts', schema.inserts || {}, otherSchema, 'inserts', sideLabel);

    root.appendChild(ul);
    root.appendChild(procFolder);
    root.appendChild(funcFolder);
    root.appendChild(viewFolder);
    root.appendChild(trigFolder);
    root.appendChild(idxFolder);
    root.appendChild(insertsFolder);

    // Events
    root.querySelectorAll('.collapser').forEach(el => {
        el.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const parent = el.parentNode.parentNode;
            const childUL = parent.querySelector(':scope > ul');
            if (!childUL) return;
            const open = (childUL.style.display === 'none');
            childUL.style.display = open ? 'block' : 'none';
            el.textContent = open ? '[-]' : '[+]';
        });
    });

    root.querySelectorAll('.node').forEach(node => {
        node.addEventListener('click', (ev) => {
            ev.stopPropagation();
            handleNodeClick(node);
        });
    });
}

/* render folder for procedures/functions/views/triggers */
function renderSimpleFolder(title, mapObj, otherSchema, kindPlural, sideLabel) {
    const liFolder = document.createElement('li');
    liFolder.innerHTML = `
        <div class="node">
            <span class="collapser">[+]</span>
            <div class="badge normal">${title}</div>
        </div>
    `;

    const innerUL = document.createElement('ul');
    innerUL.className = 'tree ml-4';
    innerUL.style.display = 'none';

    const namesThis = Object.keys(mapObj || {});
    const namesOther = Object.keys((otherSchema && otherSchema[kindPlural]) || {});
    const union = Array.from(new Set([...namesThis, ...namesOther])).sort((a,b)=>a.localeCompare(b));

    union.forEach(name => {
        const present = !!mapObj[name];
        const status = present ? compareObject(kindPlural.slice(0,-1), name, mapObj[name], otherSchema) : 'missing';

        const badgeClass = (sideLabel === 'A')
            ? ((status === 'missing' || status === 'different') ? 'blue' : 'normal')
            : ((status === 'missing' || status === 'different') ? 'red' : 'normal');

        const li = document.createElement('li');
        li.innerHTML = `
            <div class="node" data-kind="${kindPlural.slice(0,-1)}" data-name="${name}" data-side="${sideLabel}">
                <span class="collapser"></span>
                <div class="badge ${badgeClass}">${name}</div>
            </div>`;
        innerUL.appendChild(li);
    });

    liFolder.appendChild(innerUL);
    return liFolder;
}

/* render folder for indexes with additional info */
function renderIndexFolder(title, mapObj, otherSchema, sideLabel) {
    const liFolder = document.createElement('li');
    liFolder.innerHTML = `
        <div class="node">
            <span class="collapser">[+]</span>
            <div class="badge normal">${title}</div>
        </div>
    `;

    const innerUL = document.createElement('ul');
    innerUL.className = 'tree ml-4';
    innerUL.style.display = 'none';

    const namesThis = Object.keys(mapObj || {});
    const namesOther = Object.keys((otherSchema && otherSchema.indexes) || {});
    const union = Array.from(new Set([...namesThis, ...namesOther])).sort((a,b)=>a.localeCompare(b));

    union.forEach(name => {
        const idx = mapObj[name];
        const otherIdx = otherSchema && otherSchema.indexes && otherSchema.indexes[name];
        const present = !!idx;
        const status = present ? compareObject('index', name, idx, otherSchema) : 'missing';

        const badgeClass = (sideLabel === 'A')
            ? ((status === 'missing' || status === 'different') ? 'blue' : 'normal')
            : ((status === 'missing' || status === 'different') ? 'red' : 'normal');

        // Info adicional del índice
        const info = idx || otherIdx;
        let infoText = '';
        if (info) {
            const parts = [];
            if (info.unique) parts.push('UNIQUE');
            if (info.clustered) parts.push('CLUSTERED');
            if (info.nonclustered) parts.push('NONCLUSTERED');
            if (info.table) parts.push(`on ${info.table}`);
            infoText = parts.join(' ');
        }

        const li = document.createElement('li');
        li.innerHTML = `
            <div class="node" data-kind="index" data-name="${name}" data-side="${sideLabel}">
                <span class="collapser"></span>
                <div class="badge ${badgeClass}">${name}</div>
                <div style="margin-left:8px;font-size:11px;color:#666">${infoText}</div>
            </div>`;
        innerUL.appendChild(li);
    });

    liFolder.appendChild(innerUL);
    return liFolder;
}

/* compare column */
function compareColumn(tableName, colName, colObj, otherSchema) {
    if (!otherSchema || !otherSchema.tables || !otherSchema.tables[tableName]) return 'missing';
    const otherCols = otherSchema.tables[tableName].columns || {};
    const oc = otherCols[colName];
    if (!oc) return 'missing';
    if (!typesEquivalent(colObj.type, oc.type)) return 'different';
    return 'same';
}

/* when clicking a node show preview */
function handleNodeClick(node) {
    const kind = node.dataset.kind;
    const side = node.dataset.side;
    const preview = document.getElementById('preview');
    const schema = (side === 'A') ? window.schemaA : window.schemaB;
    
    if (kind === 'table') {
        const name = node.dataset.name;
        const t = schema.tables && schema.tables[name];
        if (!t) { preview.textContent = 'Tabla no encontrada.'; return; }
        preview.textContent = t.raw || formatCreateFromTable(name, t);
    } else if (kind === 'column') {
        const table = node.dataset.table;
        const col = node.dataset.name;
        const t = schema.tables && schema.tables[table];
        if (!t || !t.columns[col]) { preview.textContent = 'Columna no encontrada.'; return; }
        preview.textContent = t.columns[col].raw;
    } else if (kind === 'insert') {
        const name = node.dataset.name;
        const list = (schema.inserts && schema.inserts[name]) || [];
        if (list.length === 0) { preview.textContent = 'No hay INSERTS para esta tabla.'; return; }
        preview.textContent = list.map(x => x.raw).join('\n\n');
    } else if (kind === 'index') {
        const name = node.dataset.name;
        const idx = schema.indexes && schema.indexes[name];
        if (!idx) { preview.textContent = 'Índice no encontrado.'; return; }
        preview.textContent = idx.raw || idx;
    } else {
        const name = node.dataset.name;
        const mapName = kind + 's';
        const obj = schema[mapName] && schema[mapName][name];
        preview.textContent = obj || ('No hay definición para ' + name);
    }
}

/* format create table from parsed table to a pretty SQL (basic) */
function formatCreateFromTable(name, t) {
    let s = `CREATE TABLE ${name} (\n`;
    const cols = Object.keys(t.columns || {}).map(cn => {
        return `  ${cn} ${t.columns[cn].type || ''}`;
    });
    s += cols.join(',\n') + '\n);\n';
    return s;
}

/* ------------------------------------------------------------
   Script generation A --> B - MEJORADO
   ------------------------------------------------------------ */

function generateSyncScript(schemaA, schemaB, dialectA, dialectB) {
    const target = dialectB || 'sqlserver';
    const parts = [];
    const separator = target === 'sqlserver' ? 'GO' : '/';
    
    parts.push('-- ============================================================');
    parts.push('-- SCRIPT DE MIGRACIÓN / SINCRONIZACIÓN: A --> B');
    parts.push('-- ============================================================');
    parts.push('-- Generado: ' + (new Date()).toISOString());
    parts.push('-- Dialect origen (A): ' + (dialectA || 'unknown').toUpperCase());
    parts.push('-- Dialect destino (B): ' + (target || 'unknown').toUpperCase());
    parts.push('-- ============================================================');
    parts.push('');
    
    // SECCIÓN 1: Tablas nuevas
    parts.push('-- ============================================================');
    parts.push('-- SECCIÓN 1: CREAR TABLAS FALTANTES');
    parts.push('-- ============================================================');
    parts.push('');
    
    let tablasCreadas = 0;
    for (const tname of Object.keys(schemaA.tables || {})) {
        if (!schemaB.tables || !schemaB.tables[tname]) {
            parts.push('-- Crear tabla: ' + tname);
            parts.push(schemaA.tables[tname].raw);
            parts.push(separator);
            parts.push('');
            tablasCreadas++;
        }
    }
    if (tablasCreadas === 0) {
        parts.push('-- No hay tablas nuevas para crear');
        parts.push('');
    }

    // SECCIÓN 2: Modificar tablas existentes (agregar columnas, modificar tipos)
    parts.push('-- ============================================================');
    parts.push('-- SECCIÓN 2: MODIFICAR TABLAS EXISTENTES (COLUMNAS)');
    parts.push('-- ============================================================');
    parts.push('');
    
    let columnasModificadas = 0;
    for (const tname of Object.keys(schemaA.tables || {})) {
        if (!schemaB.tables || !schemaB.tables[tname]) continue;
        const colsA = schemaA.tables[tname].columns || {};
        const colsB = schemaB.tables[tname].columns || {};
        
        // Agregar columnas faltantes en B
        for (const col of Object.keys(colsA)) {
            if (!colsB[col]) {
                parts.push(`-- Agregar columna ${col} en tabla ${tname}`);
                const def = colsA[col].raw.replace(/,$/, '').trim();
                if (target === 'oracle') {
                    parts.push(`ALTER TABLE ${tname} ADD (${def});`);
                } else {
                    parts.push(`ALTER TABLE ${tname} ADD ${def};`);
                }
                parts.push(separator);
                parts.push('');
                columnasModificadas++;
            } else {
                // Verificar si el tipo es diferente
                const ta = colsA[col].type || '';
                const tb = colsB[col].type || '';
                if (!typesEquivalent(ta, tb)) {
                    parts.push(`-- Modificar tipo de columna ${col} en ${tname}: ${tb} -> ${ta}`);
                    if (target === 'oracle') {
                        parts.push(`ALTER TABLE ${tname} MODIFY (${col} ${ta});`);
                    } else {
                        // SQL Server necesita manejar NULL/NOT NULL
                        const nullable = colsA[col].nullable ? 'NULL' : 'NOT NULL';
                        parts.push(`ALTER TABLE ${tname} ALTER COLUMN ${col} ${ta} ${nullable};`);
                    }
                    parts.push(separator);
                    parts.push('');
                    columnasModificadas++;
                }
            }
        }
    }
    if (columnasModificadas === 0) {
        parts.push('-- No hay columnas para agregar o modificar');
        parts.push('');
    }

    // SECCIÓN 3: Índices
    parts.push('-- ============================================================');
    parts.push('-- SECCIÓN 3: ÍNDICES');
    parts.push('-- ============================================================');
    parts.push('');
    
    const idxA = schemaA.indexes || {};
    const idxB = schemaB.indexes || {};
    let indicesCreados = 0;
    
    // Crear índices faltantes
    for (const name of Object.keys(idxA)) {
        if (!idxB[name]) {
            parts.push(`-- Crear índice faltante: ${name}`);
            const idx = idxA[name];
            parts.push(idx.raw || idx);
            parts.push(separator);
            parts.push('');
            indicesCreados++;
        } else {
            // Comparar si son diferentes
            const na = normalizeWhitespace(idxA[name].raw || idxA[name]);
            const nb = normalizeWhitespace(idxB[name].raw || idxB[name]);
            if (na !== nb) {
                parts.push(`-- Recrear índice diferente: ${name}`);
                // DROP primero
                if (target === 'oracle') {
                    parts.push(`DROP INDEX ${name};`);
                } else {
                    const tableName = idxA[name].table || 'dbo.unknown';
                    parts.push(`IF EXISTS (SELECT * FROM sys.indexes WHERE name = '${name}') DROP INDEX ${name} ON ${tableName};`);
                }
                parts.push(separator);
                // CREATE
                parts.push(idxA[name].raw || idxA[name]);
                parts.push(separator);
                parts.push('');
                indicesCreados++;
            }
        }
    }
    
    // Eliminar índices que están en B pero no en A
    for (const name of Object.keys(idxB)) {
        if (!idxA[name]) {
            parts.push(`-- Eliminar índice obsoleto: ${name}`);
            if (target === 'oracle') {
                parts.push(`DROP INDEX ${name};`);
            } else {
                const tableName = idxB[name].table || 'dbo.unknown';
                parts.push(`IF EXISTS (SELECT * FROM sys.indexes WHERE name = '${name}') DROP INDEX ${name} ON ${tableName};`);
            }
            parts.push(separator);
            parts.push('');
        }
    }
    
    if (indicesCreados === 0 && Object.keys(idxB).filter(n => !idxA[n]).length === 0) {
        parts.push('-- No hay cambios en índices');
        parts.push('');
    }

    // SECCIÓN 4: Stored Procedures
    parts.push('-- ============================================================');
    parts.push('-- SECCIÓN 4: STORED PROCEDURES');
    parts.push('-- ============================================================');
    parts.push('');
    
    generateObjectSection(parts, schemaA.procedures || {}, schemaB.procedures || {}, 'PROCEDURE', target, separator);

    // SECCIÓN 5: Functions
    parts.push('-- ============================================================');
    parts.push('-- SECCIÓN 5: FUNCTIONS');
    parts.push('-- ============================================================');
    parts.push('');
    
    generateObjectSection(parts, schemaA.functions || {}, schemaB.functions || {}, 'FUNCTION', target, separator);

    // SECCIÓN 6: Views
    parts.push('-- ============================================================');
    parts.push('-- SECCIÓN 6: VIEWS');
    parts.push('-- ============================================================');
    parts.push('');
    
    generateObjectSection(parts, schemaA.views || {}, schemaB.views || {}, 'VIEW', target, separator);

    // SECCIÓN 7: Triggers
    parts.push('-- ============================================================');
    parts.push('-- SECCIÓN 7: TRIGGERS');
    parts.push('-- ============================================================');
    parts.push('');
    
    generateObjectSection(parts, schemaA.triggers || {}, schemaB.triggers || {}, 'TRIGGER', target, separator);

    // SECCIÓN 8: Inserts
    parts.push('-- ============================================================');
    parts.push('-- SECCIÓN 8: DATOS (INSERTS)');
    parts.push('-- ============================================================');
    parts.push('');
    
    const insertsA = schemaA.inserts || {};
    const insertsB = schemaB.inserts || {};
    let insertCount = 0;
    
    for (const table of Object.keys(insertsA)) {
        if (!insertsB[table]) {
            parts.push(`-- Insertar registros en tabla ${table}`);
            insertsA[table].forEach(ins => {
                parts.push(ins.raw);
            });
            parts.push(separator);
            parts.push('');
            insertCount += insertsA[table].length;
        } else {
            const rawsB = new Set(insertsB[table].map(x => normalizeWhitespace(x.raw)));
            const missing = insertsA[table].filter(ins => !rawsB.has(normalizeWhitespace(ins.raw)));
            if (missing.length > 0) {
                parts.push(`-- Insertar registros faltantes en tabla ${table}`);
                missing.forEach(ins => {
                    parts.push(ins.raw);
                });
                parts.push(separator);
                parts.push('');
                insertCount += missing.length;
            }
        }
    }
    
    if (insertCount === 0) {
        parts.push('-- No hay datos nuevos para insertar');
        parts.push('');
    }

    // SECCIÓN FINAL: Resumen
    parts.push('-- ============================================================');
    parts.push('-- FIN DEL SCRIPT DE MIGRACIÓN');
    parts.push('-- ============================================================');
    parts.push(`-- Tablas creadas: ${tablasCreadas}`);
    parts.push(`-- Columnas modificadas/agregadas: ${columnasModificadas}`);
    parts.push(`-- Índices procesados: ${indicesCreados}`);
    parts.push(`-- Registros a insertar: ${insertCount}`);
    parts.push('-- ============================================================');

    return parts.join('\n');
}

/* Helper para generar secciones de objetos (proc, func, view, trigger) */
function generateObjectSection(parts, mapA, mapB, objectType, target, separator) {
    let count = 0;
    
    // Crear/reemplazar objetos de A que faltan o son diferentes en B
    for (const name of Object.keys(mapA)) {
        if (!mapB[name]) {
            parts.push(`-- Crear ${objectType}: ${name}`);
            parts.push(mapA[name]);
            parts.push(separator);
            parts.push('');
            count++;
        } else {
            const na = normalizeWhitespace(mapA[name]);
            const nb = normalizeWhitespace(mapB[name]);
            if (na !== nb) {
                parts.push(`-- Reemplazar ${objectType} diferente: ${name}`);
                // DROP primero
                if (target === 'oracle') {
                    parts.push(`BEGIN`);
                    parts.push(`  EXECUTE IMMEDIATE 'DROP ${objectType} ${name}';`);
                    parts.push(`EXCEPTION`);
                    parts.push(`  WHEN OTHERS THEN NULL;`);
                    parts.push(`END;`);
                    parts.push('/');
                } else {
                    const objTypeCode = getObjectTypeCode(objectType);
                    parts.push(`IF OBJECT_ID(N'${name}', N'${objTypeCode}') IS NOT NULL`);
                    parts.push(`  DROP ${objectType} ${name};`);
                    parts.push(separator);
                }
                // CREATE
                parts.push(mapA[name]);
                parts.push(separator);
                parts.push('');
                count++;
            }
        }
    }
    
    // Eliminar objetos que están en B pero no en A
    for (const name of Object.keys(mapB)) {
        if (!mapA[name]) {
            parts.push(`-- Eliminar ${objectType} obsoleto: ${name}`);
            if (target === 'oracle') {
                parts.push(`BEGIN`);
                parts.push(`  EXECUTE IMMEDIATE 'DROP ${objectType} ${name}';`);
                parts.push(`EXCEPTION`);
                parts.push(`  WHEN OTHERS THEN NULL;`);
                parts.push(`END;`);
                parts.push('/');
            } else {
                const objTypeCode = getObjectTypeCode(objectType);
                parts.push(`IF OBJECT_ID(N'${name}', N'${objTypeCode}') IS NOT NULL`);
                parts.push(`  DROP ${objectType} ${name};`);
                parts.push(separator);
            }
            parts.push('');
        }
    }
    
    if (count === 0 && Object.keys(mapB).filter(n => !mapA[n]).length === 0) {
        parts.push(`-- No hay cambios en ${objectType}S`);
        parts.push('');
    }
}

/* Get SQL Server object type code for OBJECT_ID */
function getObjectTypeCode(objectType) {
    switch (objectType.toUpperCase()) {
        case 'PROCEDURE': return 'P';
        case 'FUNCTION': return 'FN';
        case 'VIEW': return 'V';
        case 'TRIGGER': return 'TR';
        default: return 'U';
    }
}

/* helper to trigger file download */
function downloadTextFile(text, filename) {
    const blob = new Blob([text], { type: 'text/sql;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    URL.revokeObjectURL(url);
    a.remove();
}

