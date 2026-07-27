import os
import csv
import json
import re
import unicodedata
from datetime import datetime

# ID de la planilla objetivo de Google Sheets
SPREADSHEET_ID = "1eQ9Y5diL5fwxYTxvseNgZJFbX-lSUQ13axbp3cLiqPc"
SHEET_DISPO_NAME = "sheet - DISPO"
DEFAULT_RUTEO_DIR = r"C:\Users\Matias Rodriguez\Documents\csv\ruteo"
DB_CHOFERES_FILE = os.path.join(DEFAULT_RUTEO_DIR, "sheet - DB_CHOFERES.csv")
DISPO_CSV_FILE = os.path.join(DEFAULT_RUTEO_DIR, "sheet - DISPO.csv")
DISPO_JSON_FILE = os.path.join(DEFAULT_RUTEO_DIR, "dispo_novedades.json")

def normalize_text(text):
    """Normaliza texto eliminando tildes y caracteres especiales para comparaciones eficientes."""
    if not text:
        return ""
    text = unicodedata.normalize('NFD', text)
    text = ''.join(c for c in text if unicodedata.category(c) != 'Mn')
    text = re.sub(r'[^A-Z0-9 ]', '', text.upper())
    return ' '.join(text.split())

def parse_fecha(fecha_str, filename=""):
    """Extrae y normaliza la fecha en formato YYYY-MM-DD y DD/MM."""
    fecha_str = fecha_str.strip() if fecha_str else ""
    
    # Intentar parsear de Fila 1 (ej: 24/7/2026, 24/07/2026, 2026-07-24)
    match_dmy = re.search(r'(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})', fecha_str)
    if match_dmy:
        d, m, y = match_dmy.groups()
        dt = datetime(int(y), int(m), int(d))
        return dt.strftime("%Y-%m-%d"), dt.strftime("%d/%m")

    match_ymd = re.search(r'(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})', fecha_str)
    if match_ymd:
        y, m, d = match_ymd.groups()
        dt = datetime(int(y), int(m), int(d))
        return dt.strftime("%Y-%m-%d"), dt.strftime("%d/%m")

    # Si la Fila 1 no tiene fecha, buscar en el nombre de archivo (ej: 2026-07-24 UTE...)
    match_file = re.search(r'(\d{4}-\d{2}-\d{2})', filename)
    if match_file:
        ymd = match_file.group(1)
        dt = datetime.strptime(ymd, "%Y-%m-%d")
        return dt.strftime("%Y-%m-%d"), dt.strftime("%d/%m")

    return datetime.now().strftime("%Y-%m-%d"), datetime.now().strftime("%d/%m")

def cargar_db_choferes(db_path=DB_CHOFERES_FILE):
    """Carga la base de datos de choferes para asociar ID de chofer y credenciales de app."""
    choferes = {}
    if not os.path.exists(db_path):
        print(f"[!] Warning: No se encontró la DB de choferes en {db_path}")
        return choferes

    with open(db_path, mode='r', encoding='utf-8-sig') as f:
        reader = csv.reader(f)
        for row in reader:
            if len(row) > 1:
                id_chofer = row[0].strip()
                if not id_chofer.startswith('drv_'):
                    continue
                official_name = row[1].strip()
                data = {
                    'id': id_chofer,
                    'nombre': official_name,
                    'dni': row[6].strip() if len(row) > 6 else '',
                    'pass': row[7].strip() if len(row) > 7 else ''
                }
                # Indexar todas las variantes de nombre (cols 1, 3, 5)
                for col_idx in [1, 3, 5]:
                    if col_idx < len(row) and row[col_idx]:
                        norm = normalize_text(row[col_idx])
                        if norm:
                            choferes[norm] = data
    return choferes

def buscar_chofer(nombre_raw, choferes_db):
    """Busca un chofer por coincidencia exacta o por palabras clave (ej: Apellido y Nombre)."""
    norm = normalize_text(nombre_raw)
    if not norm:
        return {}

    # 1. Coincidencia directa
    if norm in choferes_db:
        return choferes_db[norm]

    # 2. Coincidencia parcial por 2 palabras (Apellido + Nombre)
    words = norm.split()
    if len(words) >= 2:
        for key, data in choferes_db.items():
            kwords = key.split()
            if words[0] in kwords and words[1] in kwords:
                return data

    return {}

def parsear_csv_ruteo(filepath, db_choferes=None):
    """
    Parsea una planilla o CSV de ruteo extraendo 2 listas:
    - Lista 1: Cols B (Horario) y C (Nombre) + Terminal Fila 2 Bloque 1
    - Lista 2: Cols F (Horario) y G (Nombre) + Terminal Fila 2 Bloque 2
    """
    if db_choferes is None:
        db_choferes = cargar_db_choferes()

    filename = os.path.basename(filepath)
    with open(filepath, mode='r', encoding='utf-8-sig') as f:
        reader = list(csv.reader(f))

    if len(reader) < 3:
        print(f"[!] Archivo {filename} no tiene suficientes filas.")
        return []

    # Fila 1: Fecha
    row1 = reader[0]
    raw_fecha_b1 = row1[0].strip() if len(row1) > 0 else ""
    fecha_iso, fecha_corta = parse_fecha(raw_fecha_b1, filename)

    # Fila 2: Terminales
    row2 = reader[1]
    term_b1 = row2[0].strip() if len(row2) > 0 else "TERMINAL PLAZA HUINCUL"
    term_b2 = row2[4].strip() if len(row2) > 4 else "TERMINAL DOCK SUD"

    novedades = []

    # A partir de fila 4 (índice 3 en 0-indexed)
    for row_idx, r in enumerate(reader[3:], start=4):
        # -------------------------------------------------------------
        # LISTA 1: Columna B (índice 1) Horario, Columna C (índice 2) Nombre
        # -------------------------------------------------------------
        hs1 = r[1].strip() if len(r) > 1 else ""
        nom1 = r[2].strip() if len(r) > 2 else ""

        if nom1 and nom1.upper() not in ['CHOFER', 'NOMBRE', 'HS', 'UNIDAD']:
            info_chofer1 = buscar_chofer(nom1, db_choferes)
            horario_fmt = f"{hs1} HS" if hs1.isdigit() else hs1

            novedades.append({
                'id': f"{fecha_iso}_L1_{row_idx}",
                'chofer_id': info_chofer1.get('id', f"UNMAPPED_{row_idx}"),
                'id_chofer': info_chofer1.get('id', f"UNMAPPED_{row_idx}"),
                'nom': info_chofer1.get('nombre', nom1),
                'tipo_novedad': 'ASIGNACION_RUTEO',
                'terminal': term_b1,
                'fecha_iso': fecha_iso,
                'fecha_objetivo': fecha_corta,
                'horario': horario_fmt,
                'srv': term_b1,
                'detalle': f"Presentación en {term_b1} a las {horario_fmt} hs ({fecha_corta})",
                'lista_origen': 'LISTA_1_BC',
                'resuelto': False
            })

        # -------------------------------------------------------------
        # LISTA 2: Columna F (índice 5) Horario, Columna G (índice 6) Nombre
        # -------------------------------------------------------------
        hs2 = r[5].strip() if len(r) > 5 else ""
        nom2 = r[6].strip() if len(r) > 6 else ""

        if nom2 and nom2.upper() not in ['CHOFER', 'NOMBRE', 'HS', 'UNIDAD']:
            info_chofer2 = buscar_chofer(nom2, db_choferes)
            horario_fmt2 = f"{hs2} HS" if hs2.isdigit() else hs2

            novedades.append({
                'id': f"{fecha_iso}_L2_{row_idx}",
                'chofer_id': info_chofer2.get('id', f"UNMAPPED_{row_idx}"),
                'id_chofer': info_chofer2.get('id', f"UNMAPPED_{row_idx}"),
                'nom': info_chofer2.get('nombre', nom2),
                'tipo_novedad': 'ASIGNACION_RUTEO',
                'terminal': term_b2,
                'fecha_iso': fecha_iso,
                'fecha_objetivo': fecha_corta,
                'horario': horario_fmt2,
                'srv': term_b2,
                'detalle': f"Presentación en {term_b2} a las {horario_fmt2} hs ({fecha_corta})",
                'lista_origen': 'LISTA_2_FG',
                'resuelto': False
            })

    return novedades

def generar_indice_dias(todas_novedades):
    """Genera un índice agrupando novedades/asignaciones por fecha."""
    indice = {}
    for nov in todas_novedades:
        fecha = nov['fecha_iso']
        if fecha not in indice:
            indice[fecha] = []
        indice[fecha].append(nov)
    return indice

def inyectar_en_dispo_csv(novedades, output_path=DISPO_CSV_FILE):
    """Inyecta las 2 listas procesadas en el archivo local sheet - DISPO.csv."""
    headers = [
        'ID_NOVEDAD', 'CHOFER_ID', 'CHOFER_NOMBRE', 'TERMINAL',
        'FECHA_ISO', 'FECHA_OBJETIVO', 'HORARIO', 'LISTA_ORIGEN', 'DETALLE'
    ]

    rows = [headers]
    for n in novedades:
        rows.append([
            n['id'],
            n['chofer_id'],
            n['nom'],
            n['terminal'],
            n['fecha_iso'],
            n['fecha_objetivo'],
            n['horario'],
            n['lista_origen'],
            n['detalle']
        ])

    with open(output_path, mode='w', encoding='utf-8-sig', newline='') as f:
        writer = csv.writer(f)
        writer.writerows(rows)

    print(f"[OK] Exitosamente inyectadas {len(novedades)} filas en {output_path}")

def inyectar_en_google_sheet(novedades, spreadsheet_id=SPREADSHEET_ID, sheet_name=SHEET_DISPO_NAME, service_account_path="credentials.json"):
    """Inyecta las novedades en la pestaña sheet - DISPO del Google Sheet mediante Service Account."""
    try:
        import gspread
        from google.oauth2.service_account import Credentials

        if not os.path.exists(service_account_path):
            print(f"[!] Service account file no encontrado en '{service_account_path}'. Se omite inyección remota en Google Sheets.")
            return False

        scopes = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']
        creds = Credentials.from_service_account_file(service_account_path, scopes=scopes)
        client = gspread.authorize(creds)

        doc = client.open_by_key(spreadsheet_id)
        try:
            ws = doc.worksheet(sheet_name)
        except gspread.exceptions.WorksheetNotFound:
            ws = doc.add_worksheet(title=sheet_name, rows="1000", cols="10")

        ws.clear()
        
        headers = [
            'ID_NOVEDAD', 'CHOFER_ID', 'CHOFER_NOMBRE', 'TERMINAL',
            'FECHA_ISO', 'FECHA_OBJETIVO', 'HORARIO', 'LISTA_ORIGEN', 'DETALLE'
        ]
        
        values = [headers]
        for n in novedades:
            values.append([
                n['id'],
                n['chofer_id'],
                n['nom'],
                n['terminal'],
                n['fecha_iso'],
                n['fecha_objetivo'],
                n['horario'],
                n['lista_origen'],
                n['detalle']
            ])

        ws.update(values)
        print(f"[OK] Inyectadas {len(novedades)} asignaciones en Google Sheet {spreadsheet_id} -> '{sheet_name}'")
        return True

    except Exception as e:
        print(f"[!] Error al inyectar en Google Sheet: {e}")
        return False

def procesar_directorio_ruteo(dir_path=DEFAULT_RUTEO_DIR):
    """Procesa todos los archivos de ruteo del directorio y realiza la inyección."""
    db_choferes = cargar_db_choferes(DB_CHOFERES_FILE)
    todas_novedades = []

    files = [f for f in os.listdir(dir_path) if f.endswith('.csv') and 'DISPO' in f.upper() and 'SHEET' not in f.upper()]
    if not files:
        files = [f for f in os.listdir(dir_path) if f.endswith('.csv') and 'DB_CHOFERES' not in f and 'SHEET' not in f.upper()]

    print(f"[*] Archivos encontrados para procesar: {files}")
    for fname in sorted(files):
        fpath = os.path.join(dir_path, fname)
        print(f"[*] Procesando {fname}...")
        novs = parsear_csv_ruteo(fpath, db_choferes)
        todas_novedades.extend(novs)

    print(f"[*] Total de asignaciones/novedades extraídas: {len(todas_novedades)}")

    # Guardar en JSON
    with open(DISPO_JSON_FILE, mode='w', encoding='utf-8') as f:
        json.dump(todas_novedades, f, ensure_ascii=False, indent=2)
    print(f"[OK] Guardado JSON en {DISPO_JSON_FILE}")

    # Inyectar en sheet - DISPO.csv
    inyectar_en_dispo_csv(todas_novedades, DISPO_CSV_FILE)

    # Inyectar en Google Sheet
    inyectar_en_google_sheet(todas_novedades)

    # Mostrar índice de días
    indice = generar_indice_dias(todas_novedades)
    print("\n--- ÍNDICE DE DÍAS Y TERMINALES ---")
    for fecha, lista in indice.items():
        print(f"Fecha: {fecha} | Total choferes asignados: {len(lista)}")
        for item in lista[:3]:
            print(f"   • {item['nom']} -> {item['terminal']} a las {item['horario']}")
        if len(lista) > 3:
            print(f"   ... ({len(lista)-3} choferes más)")

    return todas_novedades

if __name__ == '__main__':
    procesar_directorio_ruteo()
