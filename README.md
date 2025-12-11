# SQL Analyzer - Comparador de Esquemas SQL

Herramienta web para comparar dos archivos SQL y generar scripts de migración automáticos para actualizar una base de datos antigua a una versión nueva.

## 🎯 Propósito

Cuando tienes un sistema con una base de datos desactualizada y necesitas migrarla a una versión más reciente, esta herramienta:

1. **Compara** el esquema SQL antiguo (Archivo B - destino) con el nuevo (Archivo A - origen)
2. **Identifica** las diferencias: tablas, columnas, procedimientos, funciones, vistas, triggers, índices e inserts
3. **Genera** un script SQL completo para actualizar la base de datos destino

## ✨ Características

### Objetos SQL Soportados
- ✅ **Tablas** - Detecta tablas nuevas y columnas faltantes/modificadas
- ✅ **Stored Procedures** - Con detección correcta de BEGIN/END anidados
- ✅ **Functions** - Funciones definidas por el usuario
- ✅ **Views** - Vistas
- ✅ **Triggers** - Con soporte completo para terminaciones END/GO
- ✅ **Índices** - Incluyendo UNIQUE, CLUSTERED, NONCLUSTERED
- ✅ **Constraints** - PRIMARY KEY, FOREIGN KEY, UNIQUE, CHECK
- ✅ **INSERTs** - Datos de inicialización/semilla

### Dialectos SQL
- **SQL Server** (T-SQL) - Detecta GO, IDENTITY, GETDATE(), etc.
- **Oracle** (PL/SQL) - Detecta VARCHAR2, NUMBER, SYSDATE, etc.

### Detección Inteligente
- Terminaciones correctas: `END`, `END;`, `GO`, `GO;`
- Bloques BEGIN/END anidados en procedures y triggers
- Equivalencia de tipos entre dialectos (VARCHAR↔VARCHAR2, INT↔NUMBER, etc.)

## 🚀 Uso

1. **Abrir** `SQLAnalizer.html` en un navegador web moderno
2. **Cargar archivos**:
   - **Archivo A (Origen)**: El SQL con la estructura nueva/actualizada
   - **Archivo B (Destino)**: El SQL de la base de datos actual/antigua
3. **Clic en "Analizar y comparar"**
4. **Explorar diferencias** en los paneles visuales:
   - 🔵 Azul: Objetos en A que faltan o son diferentes en B
   - 🔴 Rojo: Objetos en B que faltan o son diferentes en A
   - ⚪ Normal: Objetos idénticos en ambos
5. **Clic en "Generar script A → B"** para descargar el script de migración

## 📄 Script de Migración Generado

El script incluye secciones organizadas:

```sql
-- ============================================================
-- SCRIPT DE MIGRACIÓN / SINCRONIZACIÓN: A --> B
-- ============================================================

-- SECCIÓN 1: CREAR TABLAS FALTANTES
-- SECCIÓN 2: MODIFICAR TABLAS EXISTENTES (COLUMNAS)
-- SECCIÓN 3: ÍNDICES
-- SECCIÓN 4: STORED PROCEDURES
-- SECCIÓN 5: FUNCTIONS
-- SECCIÓN 6: VIEWS
-- SECCIÓN 7: TRIGGERS
-- SECCIÓN 8: DATOS (INSERTS)

-- FIN DEL SCRIPT DE MIGRACIÓN
-- Resumen con contadores
```

## 📁 Archivos del Proyecto

```
sql analizer/
├── SQLAnalizer.html    # Interfaz web principal
├── compare-core.js     # Lógica de parseo y comparación
└── README.md          # Este archivo
```

## ⚠️ Consideraciones

- **Revisar siempre** el script generado antes de ejecutarlo en producción
- El script **NO elimina columnas** existentes en B que no estén en A (para preservar datos)
- Los objetos (procedures, triggers, etc.) que existen en B pero no en A **serán eliminados**
- Se recomienda hacer **backup** de la base de datos antes de ejecutar el script

## 🔧 Requisitos

- Navegador web moderno (Chrome, Firefox, Edge, Safari)
- No requiere instalación ni servidor

## 📝 Ejemplo de Uso

**Escenario**: Tienes un sistema versión 1.0 y quieres actualizar a versión 2.0

1. Exporta el schema de la BD versión 2.0 → `schema_v2.sql` (Archivo A)
2. Exporta el schema de la BD versión 1.0 → `schema_v1.sql` (Archivo B)
3. Carga ambos archivos en la herramienta
4. Genera el script de migración
5. Revisa y ejecuta el script en la BD versión 1.0

## 🤝 Contribuciones

Este proyecto es de código abierto. Siéntete libre de:
- Reportar bugs
- Sugerir mejoras
- Enviar pull requests

---

**Nota**: Esta herramienta realiza un análisis heurístico del SQL. Para esquemas muy complejos o sintaxis no estándar, se recomienda revisar manualmente el script generado.

