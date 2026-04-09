import React, { useState, useEffect, useRef } from 'react';
import { Reservation } from './types';
import { getNights, getMonthString, formatItalianDate, checkOkkio, isPastCheckout } from './utils/reservationUtils';
import * as XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';
import { Plus, Download, Upload, Trash2, AlertTriangle, CalendarDays, Building, Users, Pencil, ImagePlus, Loader2, LogOut, PieChart, ArrowUpDown, ArrowUp, ArrowDown, MessageCircle, Settings } from 'lucide-react';
import { parse, format, isValid } from 'date-fns';
import { it } from 'date-fns/locale';
import { GoogleGenAI } from '@google/genai';
import { auth, db, loginWithGoogle, logout } from './firebase';
import { onAuthStateChanged, User } from 'firebase/auth';
import { collection, onSnapshot, doc, setDoc, deleteDoc, writeBatch } from 'firebase/firestore';
import { isCheckoutImminent } from './utils/reservationUtils';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [sortConfig, setSortConfig] = useState<{ key: string, direction: 'asc' | 'desc' } | null>({ key: 'checkIn', direction: 'asc' });

  const [showForm, setShowForm] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [reminderAdvanceDays, setReminderAdvanceDays] = useState<number>(() => {
    const saved = localStorage.getItem('bnb-reminder-days');
    return saved ? parseInt(saved) : 1;
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [notification, setNotification] = useState<{message: string, type: 'success'|'error'} | null>(null);
  const [activeTab, setActiveTab] = useState<'reservations' | 'analytics'>('reservations');

  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [notification]);
  useEffect(() => {
    localStorage.setItem('bnb-reminder-days', reminderAdvanceDays.toString());
  }, [reminderAdvanceDays]);

  const [formData, setFormData] = useState<Partial<Reservation>>({
    checkIn: '',
    checkOut: '',
    adults: 2,
    children: 0,
    portal: 'Airbnb',
    notes: '',
    phone: ''
  });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const screenshotInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!isAuthReady || !user) {
      setReservations([]);
      return;
    }

    const reservationsRef = collection(db, `users/${user.uid}/reservations`);
    const unsubscribe = onSnapshot(reservationsRef, (snapshot) => {
      const fetchedReservations: Reservation[] = [];
      snapshot.forEach((doc) => {
        fetchedReservations.push(doc.data() as Reservation);
      });
      setReservations(fetchedReservations);
    }, (error) => {
      console.error("Error fetching reservations:", error);
      setNotification({ message: "Errore nel caricamento delle prenotazioni.", type: 'error' });
    });

    return () => unsubscribe();
  }, [user, isAuthReady]);

  const sortedReservations = React.useMemo(() => {
    let sortableItems = [...reservations];
    if (sortConfig !== null) {
      sortableItems.sort((a, b) => {
        let aValue: any = a[sortConfig.key as keyof Reservation];
        let bValue: any = b[sortConfig.key as keyof Reservation];

        if (sortConfig.key === 'guests') {
          aValue = a.adults + a.children;
          bValue = b.adults + b.children;
        } else if (sortConfig.key === 'nights') {
          aValue = getNights(a.checkIn, a.checkOut);
          bValue = getNights(b.checkIn, b.checkOut);
        } else if (sortConfig.key === 'okkio') {
          aValue = checkOkkio(a, reservations) ? 1 : 0;
          bValue = checkOkkio(b, reservations) ? 1 : 0;
        } else if (sortConfig.key === 'month') {
          aValue = a.checkIn; // Sort by check-in date for month
          bValue = b.checkIn;
        } else if (sortConfig.key === 'portal') {
          aValue = a.portal.toLowerCase();
          bValue = b.portal.toLowerCase();
        }

        if (aValue < bValue) {
          return sortConfig.direction === 'asc' ? -1 : 1;
        }
        if (aValue > bValue) {
          return sortConfig.direction === 'asc' ? 1 : -1;
        }
        return 0;
      });
    }
    return sortableItems;
  }, [reservations, sortConfig]);

  const requestSort = (key: string) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  const getSortIcon = (key: string) => {
    if (!sortConfig || sortConfig.key !== key) {
      return <ArrowUpDown className="w-3 h-3 ml-1 inline-block text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity" />;
    }
    if (sortConfig.direction === 'asc') {
      return <ArrowUp className="w-3 h-3 ml-1 inline-block text-blue-600" />;
    }
    return <ArrowDown className="w-3 h-3 ml-1 inline-block text-blue-600" />;
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: name === 'adults' || name === 'children' ? parseInt(value) || 0 : name === 'price' ? parseFloat(value) || 0 : value
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.checkIn || !formData.checkOut || !user) return;

    try {
      if (editingId) {
        const reservationRef = doc(db, `users/${user.uid}/reservations`, editingId);
        await setDoc(reservationRef, { ...formData, userId: user.uid }, { merge: true });
        setNotification({ message: 'Prenotazione aggiornata', type: 'success' });
      } else {
        const newId = crypto.randomUUID();
        const newReservation = {
          id: newId,
          userId: user.uid,
          checkIn: formData.checkIn as string,
          checkOut: formData.checkOut as string,
          adults: formData.adults as number,
          children: formData.children as number,
          portal: formData.portal as string,
          notes: formData.notes as string || '',
          phone: formData.phone as string || '',
          price: formData.price as number || 0,
          createdAt: new Date().toISOString()
        };
        const reservationRef = doc(db, `users/${user.uid}/reservations`, newId);
        await setDoc(reservationRef, newReservation);
        setNotification({ message: 'Prenotazione aggiunta', type: 'success' });
      }
      closeForm();
    } catch (error) {
      console.error("Error saving reservation:", error);
      setNotification({ message: "Errore durante il salvataggio.", type: 'error' });
    }
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingId(null);
    setFormData({
      checkIn: '',
      checkOut: '',
      adults: 2,
      children: 0,
      portal: 'Airbnb',
      notes: '',
      phone: '',
      price: 0
    });
  };

  const handleEdit = (reservation: Reservation) => {
    setFormData(reservation);
    setEditingId(reservation.id);
    setShowForm(true);
  };

  const handleScreenshotUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsAnalyzing(true);
    try {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = async () => {
        try {
          const base64Data = (reader.result as string).split(',')[1];
          const apiKey = process.env.GEMINI_API_KEY;
          if (!apiKey || apiKey === 'undefined') {
            setNotification({ message: "Chiave API di Gemini mancante. Configurala su Netlify.", type: 'error' });
            setIsAnalyzing(false);
            return;
          }
          
          const ai = new GoogleGenAI({ apiKey });
          
          const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: [
              {
                role: 'user',
                parts: [
                  { text: 'Extract reservation details from this screenshot. Return ONLY a JSON object with the following keys: checkIn (YYYY-MM-DD format), checkOut (YYYY-MM-DD format), adults (number), children (number), portal (string, one of: Airbnb, Booking, Privato, Altro), notes (string, any extra info). If a value is missing, use reasonable defaults (e.g., 2 for adults, 0 for children, empty string for notes).' },
                  { inlineData: { data: base64Data, mimeType: file.type } }
                ]
              }
            ],
            config: {
              responseMimeType: 'application/json',
            }
          });

          if (response.text) {
            const data = JSON.parse(response.text);
            setFormData(prev => ({
              ...prev,
              checkIn: data.checkIn || prev.checkIn,
              checkOut: data.checkOut || prev.checkOut,
              adults: data.adults !== undefined ? data.adults : prev.adults,
              children: data.children !== undefined ? data.children : prev.children,
              portal: data.portal || prev.portal,
              notes: data.notes || prev.notes
            }));
          }
        } catch (err) {
          console.error("Error analyzing image with Gemini:", err);
          setNotification({ message: "Errore durante l'analisi dell'immagine. Inserisci i dati manualmente.", type: 'error' });
        } finally {
          setIsAnalyzing(false);
          if (screenshotInputRef.current) screenshotInputRef.current.value = '';
        }
      };
    } catch (err) {
      console.error("Error reading file:", err);
      setIsAnalyzing(false);
    }
  };

  const handleDelete = (id: string) => {
    setDeleteConfirmId(id);
  };

  const confirmDelete = async () => {
    if (deleteConfirmId && user) {
      try {
        await deleteDoc(doc(db, `users/${user.uid}/reservations`, deleteConfirmId));
        setDeleteConfirmId(null);
        setNotification({ message: 'Prenotazione eliminata', type: 'success' });
      } catch (error) {
        console.error("Error deleting reservation:", error);
        setNotification({ message: "Errore durante l'eliminazione.", type: 'error' });
      }
    }
  };

  const exportExcel = async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Prenotazioni');

    worksheet.columns = [
      { header: 'MESE', key: 'mese', width: 15 },
      { header: 'CHECK IN', key: 'checkIn', width: 25 },
      { header: 'CHECK OUT', key: 'checkOut', width: 25 },
      { header: 'GIORNI', key: 'giorni', width: 10 },
      { header: 'OKKIO', key: 'okkio', width: 15 },
      { header: 'ADULTI', key: 'adulti', width: 10 },
      { header: 'BAMBINI < 3', key: 'bambini', width: 15 },
      { header: 'CHECK IN', key: 'checkIn2', width: 15 },
      { header: 'PORTALE', key: 'portale', width: 15 },
      { header: 'NOTE', key: 'note', width: 20 },
    ];

    // Ensure it's sorted by checkIn
    const sortedReservations = [...reservations].sort((a, b) => a.checkIn.localeCompare(b.checkIn));

    sortedReservations.forEach(r => {
      const isOkkio = checkOkkio(r, sortedReservations);
      const row = worksheet.addRow({
        mese: getMonthString(r.checkIn, r.checkOut),
        checkIn: formatItalianDate(r.checkIn),
        checkOut: formatItalianDate(r.checkOut),
        giorni: getNights(r.checkIn, r.checkOut),
        okkio: isOkkio ? 'ATTENTO' : '-',
        adulti: r.adults,
        bambini: r.children || '',
        checkIn2: '',
        portale: r.portal,
        note: r.notes
      });

      let bgColor = 'FFFFFFFF'; // Default white
      const portalLower = r.portal.toLowerCase();
      if (portalLower === 'booking') bgColor = 'FFD9E1F2'; // Light blue
      else if (portalLower === 'airbnb') bgColor = 'FFFCE4D6'; // Light orange
      else if (portalLower === 'privato') bgColor = 'FFFFFF00'; // Bright yellow

      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: bgColor }
        };
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' }
        };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      });

      // OKKIO styling (column 5)
      const okkioCell = row.getCell(5);
      if (isOkkio) {
        okkioCell.font = { color: { argb: 'FFFF0000' }, bold: true, italic: true, underline: true };
      } else {
        okkioCell.font = { color: { argb: 'FFFF0000' } };
      }
    });

    // Header styling
    worksheet.getRow(1).eachCell((cell) => {
      cell.font = { bold: true };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFEFEFEF' }
      };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' }
      };
    });

    const buffer = await workbook.xlsx.writeBuffer();
    saveAs(new Blob([buffer]), 'prenotazioni_bnb.xlsx');
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const bstr = evt.target?.result;
        const workbook = XLSX.read(bstr, { type: 'binary', cellDates: true });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        
        // raw: false ensures dates are formatted as strings if they are date cells
        const data = XLSX.utils.sheet_to_json(worksheet, { raw: false }) as any[];

        const parsedReservations: Reservation[] = [];
        let errorCount = 0;
        
        data.forEach((row: any, index: number) => {
          try {
            const checkInStr = row['CHECK IN'];
            const checkOutStr = row['CHECK OUT'];

            // Salta le righe vuote o senza entrambe le date senza generare errori
            if (!checkInStr && !checkOutStr) {
              return;
            }

            // Parse Italian dates like "sabato 7 marzo 2026" or English dates
            const parseDate = (dateStr: string) => {
              if (!dateStr) return null;
              
              // Handle standard YYYY-MM-DD
              if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
              
              // Try standard JS Date parsing (handles English dates like "Saturday, March 07, 2026" and MM/DD/YYYY)
              const standardParsed = new Date(dateStr);
              if (isValid(standardParsed)) {
                 // To avoid parsing random numbers as years, ensure it has some date-like characters
                 if (/[a-zA-Z/]/.test(dateStr) || /-/.test(dateStr) || /,/.test(dateStr)) {
                   return format(standardParsed, 'yyyy-MM-dd');
                 }
              }

              // Handle Italian dates
              const parts = dateStr.split(' ');
              if (parts.length >= 4) {
                const cleanDate = parts.slice(1).join(' ');
                const parsed = parse(cleanDate, 'd MMMM yyyy', new Date(), { locale: it });
                if (isValid(parsed)) return format(parsed, 'yyyy-MM-dd');
              }
              return null;
            };

            const checkIn = parseDate(checkInStr);
            const checkOut = parseDate(checkOutStr);

            if (!checkIn || !checkOut) {
              console.error(`Errore riga ${index + 2}: Date mancanti o formato non valido. Check-in: ${checkInStr}, Check-out: ${checkOutStr}`);
              errorCount++;
              return;
            }

            if (new Date(checkOut) < new Date(checkIn)) {
              console.error(`Errore riga ${index + 2}: Data di check-out precedente al check-in. Check-in: ${checkIn}, Check-out: ${checkOut}`);
              errorCount++;
              return;
            }

            parsedReservations.push({
              id: crypto.randomUUID(),
              checkIn,
              checkOut,
              adults: parseInt(row['ADULTI']) || 0,
              children: parseInt(row['BAMBINI < 3'] || row['BAMBINI']) || 0,
              portal: row['PORTALE'] || '',
              notes: row['NOTE'] || '',
              phone: row['TELEFONO'] || '',
              price: parseFloat(row['PREZZO'] || row['IMPORTO'] || row['PRICE']) || 0
            });
          } catch (err) {
            console.error(`Errore durante il parsing della riga ${index + 2}`, row, err);
            errorCount++;
          }
        });

        if (parsedReservations.length > 0 && user) {
          try {
            const batch = writeBatch(db);
            parsedReservations.forEach(res => {
              const resWithUser = { ...res, userId: user.uid, createdAt: new Date().toISOString() };
              const docRef = doc(db, `users/${user.uid}/reservations`, res.id);
              batch.set(docRef, resWithUser);
            });
            await batch.commit();
            
            if (errorCount > 0) {
              setNotification({ message: `${parsedReservations.length} prenotazioni importate. ${errorCount} righe ignorate per errori (vedi console).`, type: 'success' });
            } else {
              setNotification({ message: `${parsedReservations.length} prenotazioni importate con successo!`, type: 'success' });
            }
          } catch (error) {
            console.error("Error batch writing reservations:", error);
            setNotification({ message: "Errore durante il salvataggio delle prenotazioni importate.", type: 'error' });
          }
        } else if (parsedReservations.length === 0) {
          setNotification({ message: "Nessuna prenotazione valida trovata nel file.", type: 'error' });
        }
      } catch (error) {
        console.error("Error reading file:", error);
        setNotification({ message: "Errore durante la lettura del file Excel.", type: 'error' });
      }
    };
    reader.readAsBinaryString(file);
    
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  if (!isAuthReady) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4">
        <div className="bg-white p-8 rounded-xl shadow-sm border border-gray-200 max-w-md w-full text-center">
          <div className="flex items-center justify-center mx-auto mb-6">
            <img 
              src="https://lh3.googleusercontent.com/d/1_pSyAN_t2vDeot5IfGGfH1m9vVWYf76I" 
              alt="SariaOccupazione Logo" 
              className="h-24 object-contain"
              referrerPolicy="no-referrer"
            />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">SariaOccupazione</h1>
          <p className="text-gray-500 mb-8">Accedi per gestire le tue prenotazioni in cloud e sincronizzarle su tutti i tuoi dispositivi.</p>
          <button
            onClick={loginWithGoogle}
            className="w-full flex items-center justify-center gap-3 px-4 py-3 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors shadow-sm"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
            </svg>
            Accedi con Google
          </button>
        </div>
      </div>
    );
  }

  // Analytics Calculations
  const totalNights = reservations.reduce((acc, curr) => acc + getNights(curr.checkIn, curr.checkOut), 0);
  const avgStayDuration = reservations.length > 0 ? (totalNights / reservations.length).toFixed(1) : '0';
  
  // Occupancy rate calculation (based on the first and last reservation dates, or current year if empty)
  let occupancyRate = '0';
  if (reservations.length > 0) {
    const dates = reservations.flatMap(r => [new Date(r.checkIn), new Date(r.checkOut)]);
    const minDate = new Date(Math.min(...dates.map(d => d.getTime())));
    const maxDate = new Date(Math.max(...dates.map(d => d.getTime())));
    const totalDaysInRange = Math.max(1, Math.ceil((maxDate.getTime() - minDate.getTime()) / (1000 * 60 * 60 * 24)));
    occupancyRate = ((totalNights / totalDaysInRange) * 100).toFixed(1);
  }

  // Revenue per portal
  const revenueByPortal = reservations.reduce((acc, curr) => {
    const portal = curr.portal || 'Altro';
    acc[portal] = (acc[portal] || 0) + (curr.price || 0);
    return acc;
  }, {} as Record<string, number>);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans">
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img 
              src="https://lh3.googleusercontent.com/d/1_pSyAN_t2vDeot5IfGGfH1m9vVWYf76I" 
              alt="SariaOccupazione Logo" 
              className="h-10 object-contain"
              referrerPolicy="no-referrer"
            />
            <h1 className="text-xl font-semibold tracking-tight hidden sm:block">SariaOccupazione</h1>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex bg-gray-100 p-1 rounded-lg mr-4">
              <button
                onClick={() => setActiveTab('reservations')}
                className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${activeTab === 'reservations' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
              >
                Prenotazioni
              </button>
              <button
                onClick={() => setActiveTab('analytics')}
                className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${activeTab === 'analytics' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
              >
                Analisi
              </button>
            </div>
            <button
              onClick={logout}
              className="inline-flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors mr-2"
              title="Esci"
            >
              <LogOut className="w-4 h-4" />
              <span className="hidden sm:inline">Esci</span>
            </button>
            <button
              onClick={() => setShowSettings(true)}
              className="inline-flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors mr-2"
              title="Impostazioni"
            >
              <Settings className="w-4 h-4" />
            </button>
            <input 
              type="file" 
              accept=".csv, .xlsx, .xls" 
              className="hidden" 
              ref={fileInputRef}
              onChange={handleFileUpload}
            />
            {activeTab === 'reservations' && (
              <>
                <button 
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
                >
                  <Upload className="w-4 h-4" />
                  <span className="hidden sm:inline">Importa Excel/CSV</span>
                </button>
                <button 
                  onClick={exportExcel}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
                >
                  <Download className="w-4 h-4" />
                  <span className="hidden sm:inline">Esporta Excel</span>
                </button>
                <button 
                  onClick={() => {
                    if (!showForm || editingId) {
                      setFormData({ checkIn: '', checkOut: '', adults: 2, children: 0, portal: 'Airbnb', notes: '', phone: '', price: 0 });
                      setEditingId(null);
                      setShowForm(true);
                    } else {
                      setShowForm(false);
                    }
                  }}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors shadow-sm"
                >
                  <Plus className="w-4 h-4" />
                  Nuova
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        
        {activeTab === 'analytics' ? (
          <div className="space-y-6">
            <h2 className="text-2xl font-semibold text-gray-900">Analisi e Statistiche</h2>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 className="text-sm font-medium text-gray-500 mb-2">Tasso di Occupazione</h3>
                <div className="flex items-end gap-2">
                  <span className="text-4xl font-bold text-gray-900">{occupancyRate}%</span>
                </div>
                <p className="text-xs text-gray-500 mt-2">Calcolato sul periodo della prima e ultima prenotazione</p>
              </div>
              
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 className="text-sm font-medium text-gray-500 mb-2">Durata Media Soggiorno</h3>
                <div className="flex items-end gap-2">
                  <span className="text-4xl font-bold text-gray-900">{avgStayDuration}</span>
                  <span className="text-lg text-gray-600 mb-1">notti</span>
                </div>
              </div>

              <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 className="text-sm font-medium text-gray-500 mb-2">Ricavi Totali</h3>
                <div className="flex items-end gap-2">
                  <span className="text-4xl font-bold text-gray-900">
                    €{Object.values(revenueByPortal).reduce((a, b) => a + b, 0).toFixed(2)}
                  </span>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
              <h3 className="text-lg font-medium text-gray-900 mb-6">Ricavi per Portale</h3>
              <div className="space-y-4">
                {Object.entries(revenueByPortal).sort((a, b) => b[1] - a[1]).map(([portal, revenue]) => (
                  <div key={portal} className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`w-3 h-3 rounded-full ${
                        portal.toLowerCase() === 'airbnb' ? 'bg-rose-500' :
                        portal.toLowerCase() === 'booking' ? 'bg-blue-500' :
                        'bg-emerald-500'
                      }`} />
                      <span className="font-medium text-gray-700">{portal}</span>
                    </div>
                    <span className="font-semibold text-gray-900">€{revenue.toFixed(2)}</span>
                  </div>
                ))}
                {Object.keys(revenueByPortal).length === 0 && (
                  <p className="text-gray-500 text-sm">Nessun dato sui ricavi disponibile.</p>
                )}
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Stats */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 flex items-center gap-4">
            <div className="p-3 bg-blue-50 text-blue-600 rounded-lg">
              <CalendarDays className="w-6 h-6" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-500">Totale Prenotazioni</p>
              <p className="text-2xl font-semibold">{reservations.length}</p>
            </div>
          </div>
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 flex items-center gap-4">
            <div className="p-3 bg-indigo-50 text-indigo-600 rounded-lg">
              <PieChart className="w-6 h-6" />
            </div>
            <div className="w-full">
              <p className="text-sm font-medium text-gray-500 mb-1">Portali</p>
              <div className="flex gap-3 text-xs font-medium">
                <div className="flex flex-col">
                  <span className="text-gray-400">Airbnb</span>
                  <span className="text-gray-900 text-sm">{reservations.filter(r => r.portal.toLowerCase() === 'airbnb').length}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-gray-400">Booking</span>
                  <span className="text-gray-900 text-sm">{reservations.filter(r => r.portal.toLowerCase() === 'booking').length}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-gray-400">Privato</span>
                  <span className="text-gray-900 text-sm">{reservations.filter(r => r.portal.toLowerCase() === 'privato').length}</span>
                </div>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 flex items-center gap-4">
            <div className="p-3 bg-green-50 text-green-600 rounded-lg">
              <Users className="w-6 h-6" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-500">Ospiti Totali</p>
              <p className="text-2xl font-semibold">
                {reservations.reduce((acc, curr) => acc + curr.adults + curr.children, 0)}
              </p>
            </div>
          </div>
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 flex items-center gap-4">
            <div className="p-3 bg-amber-50 text-amber-600 rounded-lg">
              <AlertTriangle className="w-6 h-6" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-500">Turnover (Okkio)</p>
              <p className="text-2xl font-semibold">
                {reservations.filter(r => checkOkkio(r, reservations)).length}
              </p>
            </div>
          </div>
        </div>

        {showForm && (
          <div className="mb-8 bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 bg-gray-50 flex justify-between items-center">
              <h2 className="text-lg font-medium text-gray-900">
                {editingId ? 'Modifica Prenotazione' : 'Aggiungi Prenotazione'}
              </h2>
              {!editingId && (
                <div>
                  <input 
                    type="file" 
                    accept="image/*" 
                    className="hidden" 
                    ref={screenshotInputRef}
                    onChange={handleScreenshotUpload}
                  />
                  <button
                    type="button"
                    onClick={() => screenshotInputRef.current?.click()}
                    disabled={isAnalyzing}
                    className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors disabled:opacity-50"
                  >
                    {isAnalyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImagePlus className="w-4 h-4" />}
                    {isAnalyzing ? 'Analisi in corso...' : 'Carica Screenshot'}
                  </button>
                </div>
              )}
            </div>
            <form onSubmit={handleSubmit} className="p-6">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Check-in</label>
                  <input 
                    type="date" 
                    name="checkIn"
                    required
                    value={formData.checkIn}
                    onChange={handleInputChange}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Check-out</label>
                  <input 
                    type="date" 
                    name="checkOut"
                    required
                    value={formData.checkOut}
                    onChange={handleInputChange}
                    min={formData.checkIn}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Portale</label>
                  <select 
                    name="portal"
                    value={formData.portal}
                    onChange={handleInputChange}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="Airbnb">Airbnb</option>
                    <option value="Booking">Booking</option>
                    <option value="Privato">Privato</option>
                    <option value="Altro">Altro</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Adulti</label>
                  <input 
                    type="number" 
                    name="adults"
                    min="1"
                    required
                    value={formData.adults}
                    onChange={handleInputChange}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Bambini &lt; 3 anni</label>
                  <input 
                    type="number" 
                    name="children"
                    min="0"
                    value={formData.children}
                    onChange={handleInputChange}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Note</label>
                  <input 
                    type="text" 
                    name="notes"
                    value={formData.notes}
                    onChange={handleInputChange}
                    placeholder="Opzionale"
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Telefono (WhatsApp)</label>
                  <input 
                    type="text" 
                    name="phone"
                    value={formData.phone || ''}
                    onChange={handleInputChange}
                    placeholder="es. +393331234567"
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Prezzo (€)</label>
                  <input 
                    type="number" 
                    name="price"
                    min="0"
                    step="0.01"
                    value={formData.price || ''}
                    onChange={handleInputChange}
                    placeholder="es. 150.00"
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
              </div>
              <div className="mt-6 flex justify-end gap-3">
                <button 
                  type="button"
                  onClick={closeForm}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                >
                  Annulla
                </button>
                <button 
                  type="submit"
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 shadow-sm"
                >
                  {editingId ? 'Aggiorna Prenotazione' : 'Salva Prenotazione'}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Table */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer group select-none" onClick={() => requestSort('month')}>
                    Mese {getSortIcon('month')}
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer group select-none" onClick={() => requestSort('checkIn')}>
                    Check In {getSortIcon('checkIn')}
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer group select-none" onClick={() => requestSort('checkOut')}>
                    Check Out {getSortIcon('checkOut')}
                  </th>
                  <th scope="col" className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer group select-none" onClick={() => requestSort('nights')}>
                    Giorni {getSortIcon('nights')}
                  </th>
                  <th scope="col" className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer group select-none" onClick={() => requestSort('okkio')}>
                    Okkio {getSortIcon('okkio')}
                  </th>
                  <th scope="col" className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer group select-none" onClick={() => requestSort('guests')}>
                    Ospiti {getSortIcon('guests')}
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer group select-none" onClick={() => requestSort('portal')}>
                    Portale {getSortIcon('portal')}
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer group select-none" onClick={() => requestSort('notes')}>
                    Note {getSortIcon('notes')}
                  </th>
                  <th scope="col" className="relative px-6 py-3"><span className="sr-only">Azioni</span></th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {sortedReservations.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-6 py-12 text-center text-gray-500">
                      Nessuna prenotazione presente. Aggiungine una o importa il tuo file CSV.
                    </td>
                  </tr>
                ) : (
                  sortedReservations.map((res) => {
                    const isOkkio = checkOkkio(res, reservations);
                    const pastCheckout = isPastCheckout(res.checkOut);
                    const isImminent = isCheckoutImminent(res.checkOut, reminderAdvanceDays);
                    
                    const handleWhatsApp = () => {
                      if (!res.phone) return;
                      const message = `Gentile ospite, le ricordiamo che il check-out è previsto per il ${formatItalianDate(res.checkOut)}. Speriamo che il suo soggiorno sia stato piacevole!`;
                      const url = `https://wa.me/${res.phone.replace(/[^0-9+]/g, '')}?text=${encodeURIComponent(message)}`;
                      window.open(url, '_blank');
                    };

                    return (
                      <tr key={res.id} className={`hover:bg-gray-50 transition-colors ${pastCheckout ? 'bg-red-50/50' : ''}`}>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 font-medium">
                          {getMonthString(res.checkIn, res.checkOut)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">
                          {formatItalianDate(res.checkIn)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">
                          <div className="flex flex-col gap-1">
                            <span>{formatItalianDate(res.checkOut)}</span>
                            {pastCheckout && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-red-100 text-red-800 w-fit">
                                DA ELIMINARE
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-center font-medium">
                          {getNights(res.checkIn, res.checkOut)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-center">
                          {isOkkio && (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                              ATTENTO
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700 text-center">
                          {res.adults} {res.children > 0 && <span className="text-gray-400 text-xs">(+{res.children})</span>}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm">
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                            res.portal.toLowerCase() === 'airbnb' ? 'bg-rose-100 text-rose-800' :
                            res.portal.toLowerCase() === 'booking' ? 'bg-blue-100 text-blue-800' :
                            'bg-emerald-100 text-emerald-800'
                          }`}>
                            {res.portal}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-500 max-w-xs truncate">
                          {res.notes}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                          <div className="flex items-center justify-end gap-2">
                            {res.phone && isImminent && !pastCheckout && (
                              <button 
                                onClick={handleWhatsApp}
                                className="text-green-600 hover:text-green-700 transition-colors bg-green-50 p-1.5 rounded-full"
                                title="Invia promemoria WhatsApp"
                              >
                                <MessageCircle className="w-4 h-4" />
                              </button>
                            )}
                            <button 
                              onClick={() => handleEdit(res)}
                              className="text-gray-400 hover:text-blue-600 transition-colors p-1.5"
                              title="Modifica"
                            >
                              <Pencil className="w-4 h-4" />
                            </button>
                            <button 
                              onClick={() => handleDelete(res.id)}
                              className="text-gray-400 hover:text-red-600 transition-colors p-1.5"
                              title="Elimina"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
        </>
        )}
      </main>

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-lg max-w-sm w-full p-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Impostazioni Promemoria</h3>
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Anticipo promemoria check-out (giorni)
              </label>
              <input 
                type="number" 
                min="0"
                max="7"
                value={reminderAdvanceDays}
                onChange={(e) => setReminderAdvanceDays(parseInt(e.target.value) || 0)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
              <p className="text-xs text-gray-500 mt-2">
                L'icona di WhatsApp apparirà per le prenotazioni che terminano entro questo numero di giorni.
              </p>
            </div>
            <div className="flex justify-end">
              <button 
                onClick={() => setShowSettings(false)}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                Chiudi
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirmId && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-lg max-w-sm w-full p-6">
            <h3 className="text-lg font-medium text-gray-900 mb-2">Conferma eliminazione</h3>
            <p className="text-sm text-gray-500 mb-6">Sei sicuro di voler eliminare questa prenotazione? L'operazione non può essere annullata.</p>
            <div className="flex justify-end gap-3">
              <button 
                onClick={() => setDeleteConfirmId(null)}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                Annulla
              </button>
              <button 
                onClick={confirmDelete}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 border border-transparent rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
              >
                Elimina
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {notification && (
        <div className={`fixed bottom-4 right-4 px-4 py-3 rounded-lg shadow-lg text-white text-sm font-medium z-50 transition-all ${notification.type === 'success' ? 'bg-emerald-600' : 'bg-red-600'}`}>
          {notification.message}
        </div>
      )}
    </div>
  );
}
