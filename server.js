const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Estado en memoria ───────────────────────────────────────────────────────
let cola = [];          // { id, codigo, servicio, nombre, telefono, estado, horaCreacion, horaLlamado, horaFin, modulo, notas }
let turnos = [];        // histórico
let contadores = {};    // { 'CAJA': 1, 'INFO': 1, ... }
let modulos = {};       // { '1': { asesorId, servicio, estado: 'disponible'|'ocupado'|'pausa' } }
let asesores = [
  { id: 'a1', nombre: 'Ana García',    modulo: '1', password: '1234' },
  { id: 'a2', nombre: 'Luis Martínez', modulo: '2', password: '1234' },
  { id: 'a3', nombre: 'María López',   modulo: '3', password: '1234' },
];
let servicios = [
  { id: 's1', nombre: 'Caja',         codigo: 'CAJ', activo: true },
  { id: 's2', nombre: 'Información',  codigo: 'INF', activo: true },
  { id: 's3', nombre: 'Trámites',     codigo: 'TRA', activo: true },
  { id: 's4', nombre: 'Soporte',      codigo: 'SOP', activo: true },
];
let usuarios = [
  { id: 'u1', nombre: 'Admin', email: 'admin@turnos.com', password: 'admin123', rol: 'admin' },
];
let ultimosLlamados = []; // máx 5, para pantalla de espera

function generarCodigo(servicio) {
  const srv = servicios.find(s => s.id === servicio || s.nombre === servicio);
  const cod = srv ? srv.codigo : 'TUR';
  if (!contadores[cod]) contadores[cod] = 1;
  const num = String(contadores[cod]++).padStart(3, '0');
  return `${cod}-${num}`;
}

function calcularEspera(servicioId) {
  const enCola = cola.filter(t => t.servicio === servicioId && t.estado === 'esperando');
  return enCola.length * 5; // 5 min promedio por turno
}

function emitirEstado() {
  const estado = {
    cola: cola.filter(t => t.estado === 'esperando'),
    ultimosLlamados,
    totalEsperando: cola.filter(t => t.estado === 'esperando').length,
    servicios: servicios.map(s => ({
      ...s,
      enEspera: cola.filter(t => t.servicio === s.id && t.estado === 'esperando').length,
      tiempoEstimado: calcularEspera(s.id),
    })),
    modulos,
  };
  io.emit('estado', estado);
}

// ─── API CLIENTE ─────────────────────────────────────────────────────────────

// Obtener servicios disponibles
app.get('/api/servicios', (req, res) => {
  res.json(servicios.filter(s => s.activo).map(s => ({
    ...s,
    enEspera: cola.filter(t => t.servicio === s.id && t.estado === 'esperando').length,
    tiempoEstimado: calcularEspera(s.id),
  })));
});

// Solicitar turno
app.post('/api/turno', (req, res) => {
  const { servicioId, nombre, telefono, email } = req.body;
  if (!servicioId) return res.status(400).json({ error: 'Servicio requerido' });

  const srv = servicios.find(s => s.id === servicioId);
  if (!srv) return res.status(404).json({ error: 'Servicio no encontrado' });

  const codigo = generarCodigo(servicioId);
  const turno = {
    id: Date.now().toString(),
    codigo,
    servicio: servicioId,
    servicioNombre: srv.nombre,
    nombre: nombre || 'Cliente',
    telefono: telefono || '',
    email: email || '',
    estado: 'esperando',
    horaCreacion: new Date().toISOString(),
    horaLlamado: null,
    horaFin: null,
    modulo: null,
    notas: '',
    posicion: cola.filter(t => t.servicio === servicioId && t.estado === 'esperando').length + 1,
    tiempoEstimado: calcularEspera(servicioId) + 5,
  };

  cola.push(turno);
  emitirEstado();
  res.json({ ok: true, turno });
});

// Cancelar turno por cliente
app.post('/api/turno/:id/cancelar', (req, res) => {
  const turno = cola.find(t => t.id === req.params.id);
  if (!turno) return res.status(404).json({ error: 'Turno no encontrado' });
  turno.estado = 'cancelado';
  turno.horaFin = new Date().toISOString();
  emitirEstado();
  res.json({ ok: true });
});

// Estado de un turno específico
app.get('/api/turno/:id', (req, res) => {
  const turno = cola.find(t => t.id === req.params.id);
  if (!turno) return res.status(404).json({ error: 'No encontrado' });
  const pos = cola.filter(t => t.servicio === turno.servicio && t.estado === 'esperando' &&
    new Date(t.horaCreacion) < new Date(turno.horaCreacion)).length + 1;
  res.json({ ...turno, posicion: turno.estado === 'esperando' ? pos : 0 });
});

// ─── API ASESOR ───────────────────────────────────────────────────────────────

app.post('/api/asesor/login', (req, res) => {
  const { modulo, password } = req.body;
  const asesor = asesores.find(a => a.modulo === modulo && a.password === password);
  if (!asesor) return res.status(401).json({ error: 'Credenciales incorrectas' });
  modulos[modulo] = { asesorId: asesor.id, asesorNombre: asesor.nombre, estado: 'disponible', servicioActual: null };
  emitirEstado();
  res.json({ ok: true, asesor: { ...asesor, password: undefined } });
});

app.post('/api/asesor/llamar', (req, res) => {
  const { modulo, servicioId } = req.body;
  // Buscar siguiente turno en espera para el servicio
  const siguiente = cola.find(t =>
    t.estado === 'esperando' &&
    (!servicioId || t.servicio === servicioId)
  );
  if (!siguiente) return res.status(404).json({ error: 'No hay turnos en espera' });

  siguiente.estado = 'llamado';
  siguiente.horaLlamado = new Date().toISOString();
  siguiente.modulo = modulo;

  if (modulos[modulo]) {
    modulos[modulo].estado = 'ocupado';
    modulos[modulo].turnoActual = siguiente.id;
    modulos[modulo].servicioActual = siguiente.servicio;
  }

  // Pantalla de espera
  ultimosLlamados.unshift({ codigo: siguiente.codigo, modulo, servicioNombre: siguiente.servicioNombre, hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }) });
  if (ultimosLlamados.length > 6) ultimosLlamados.pop();

  io.emit('turno-llamado', { turno: siguiente, modulo });
  emitirEstado();
  res.json({ ok: true, turno: siguiente });
});

app.post('/api/asesor/rellamar', (req, res) => {
  const { turnoId, modulo } = req.body;
  const turno = cola.find(t => t.id === turnoId);
  if (!turno) return res.status(404).json({ error: 'Turno no encontrado' });
  io.emit('turno-llamado', { turno, modulo, rellamado: true });
  res.json({ ok: true });
});

app.post('/api/asesor/finalizar', (req, res) => {
  const { turnoId, modulo, notas } = req.body;
  const turno = cola.find(t => t.id === turnoId);
  if (!turno) return res.status(404).json({ error: 'Turno no encontrado' });
  turno.estado = 'atendido';
  turno.horaFin = new Date().toISOString();
  turno.notas = notas || '';
  if (modulos[modulo]) {
    modulos[modulo].estado = 'disponible';
    modulos[modulo].turnoActual = null;
  }
  turnos.push({ ...turno });
  emitirEstado();
  res.json({ ok: true });
});

app.post('/api/asesor/ausente', (req, res) => {
  const { turnoId, modulo } = req.body;
  const turno = cola.find(t => t.id === turnoId);
  if (!turno) return res.status(404).json({ error: 'Turno no encontrado' });
  turno.estado = 'ausente';
  turno.horaFin = new Date().toISOString();
  if (modulos[modulo]) {
    modulos[modulo].estado = 'disponible';
    modulos[modulo].turnoActual = null;
  }
  emitirEstado();
  res.json({ ok: true });
});

app.post('/api/asesor/pausa', (req, res) => {
  const { modulo, activa } = req.body;
  if (modulos[modulo]) modulos[modulo].estado = activa ? 'pausa' : 'disponible';
  emitirEstado();
  res.json({ ok: true });
});

app.get('/api/asesor/cola', (req, res) => {
  const { servicioId } = req.query;
  let lista = cola.filter(t => t.estado === 'esperando');
  if (servicioId) lista = lista.filter(t => t.servicio === servicioId);
  res.json(lista);
});

// ─── API ADMIN ────────────────────────────────────────────────────────────────

app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body;
  const u = usuarios.find(u => u.email === email && u.password === password && u.rol === 'admin');
  if (!u) return res.status(401).json({ error: 'Credenciales incorrectas' });
  res.json({ ok: true, usuario: { ...u, password: undefined } });
});

app.get('/api/admin/dashboard', (req, res) => {
  const hoy = new Date().toDateString();
  const hoyTurnos = cola.filter(t => new Date(t.horaCreacion).toDateString() === hoy);
  res.json({
    totalHoy: hoyTurnos.length,
    atendidos: hoyTurnos.filter(t => t.estado === 'atendido').length,
    esperando: cola.filter(t => t.estado === 'esperando').length,
    cancelados: hoyTurnos.filter(t => t.estado === 'cancelado').length,
    ausentes: hoyTurnos.filter(t => t.estado === 'ausente').length,
    porServicio: servicios.map(s => ({
      nombre: s.nombre,
      total: hoyTurnos.filter(t => t.servicio === s.id).length,
      esperando: cola.filter(t => t.servicio === s.id && t.estado === 'esperando').length,
    })),
    modulos: Object.entries(modulos).map(([num, m]) => ({ modulo: num, ...m })),
  });
});

app.get('/api/admin/turnos', (req, res) => {
  res.json([...turnos, ...cola].sort((a, b) => new Date(b.horaCreacion) - new Date(a.horaCreacion)).slice(0, 100));
});

app.get('/api/admin/servicios', (req, res) => res.json(servicios));
app.post('/api/admin/servicios', (req, res) => {
  const { nombre, codigo } = req.body;
  const nuevo = { id: 's' + Date.now(), nombre, codigo: codigo.toUpperCase(), activo: true };
  servicios.push(nuevo);
  res.json(nuevo);
});
app.put('/api/admin/servicios/:id', (req, res) => {
  const srv = servicios.find(s => s.id === req.params.id);
  if (!srv) return res.status(404).json({ error: 'No encontrado' });
  Object.assign(srv, req.body);
  res.json(srv);
});
app.delete('/api/admin/servicios/:id', (req, res) => {
  servicios = servicios.filter(s => s.id !== req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/usuarios', (req, res) => res.json(usuarios.map(u => ({ ...u, password: undefined }))));
app.post('/api/admin/usuarios', (req, res) => {
  const u = { id: 'u' + Date.now(), ...req.body };
  usuarios.push(u);
  res.json({ ...u, password: undefined });
});
app.delete('/api/admin/usuarios/:id', (req, res) => {
  usuarios = usuarios.filter(u => u.id !== req.params.id);
  res.json({ ok: true });
});

// Estado en tiempo real para pantalla de espera
app.get('/api/pantalla', (req, res) => {
  res.json({
    ultimosLlamados,
    esperando: cola.filter(t => t.estado === 'esperando').length,
    servicios: servicios.filter(s => s.activo).map(s => ({
      nombre: s.nombre,
      enEspera: cola.filter(t => t.servicio === s.id && t.estado === 'esperando').length,
    })),
  });
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  emitirEstado();
});

// ─── Rutas HTML ───────────────────────────────────────────────────────────────
['/', '/cliente', '/asesor', '/admin', '/pantalla'].forEach(route => {
  app.get(route, (req, res) => {
    const page = route === '/' ? 'index' : route.slice(1);
    res.sendFile(path.join(__dirname, 'public', `${page}.html`));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Servidor corriendo en http://localhost:${PORT}`));
