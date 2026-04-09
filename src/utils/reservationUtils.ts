import { parseISO, differenceInDays, format, isSameMonth, isSameDay, isBefore, startOfDay } from 'date-fns';
import { it } from 'date-fns/locale';
import { Reservation } from '../types';

export function getNights(checkIn: string, checkOut: string): number {
  if (!checkIn || !checkOut) return 0;
  return Math.max(0, differenceInDays(parseISO(checkOut), parseISO(checkIn)));
}

export function getMonthString(checkIn: string, checkOut: string): string {
  if (!checkIn || !checkOut) return '';
  const inDate = parseISO(checkIn);
  const outDate = parseISO(checkOut);
  
  const inMonth = format(inDate, 'MMMM', { locale: it });
  const outMonth = format(outDate, 'MMMM', { locale: it });
  
  if (isSameMonth(inDate, outDate)) {
    return inMonth.charAt(0).toUpperCase() + inMonth.slice(1);
  } else {
    return `${inMonth.charAt(0).toUpperCase() + inMonth.slice(1)}/${outMonth.charAt(0).toUpperCase() + outMonth.slice(1)}`;
  }
}

export function formatItalianDate(dateString: string): string {
  if (!dateString) return '';
  return format(parseISO(dateString), 'EEEE d MMMM yyyy', { locale: it });
}

export function checkOkkio(reservation: Reservation, allReservations: Reservation[]): boolean {
  if (!reservation.checkIn || !reservation.checkOut) return false;
  
  const checkInDate = parseISO(reservation.checkIn);

  for (const other of allReservations) {
    if (other.id === reservation.id) continue;
    if (!other.checkIn || !other.checkOut) continue;
    
    const otherCheckOut = parseISO(other.checkOut);

    // Mostra l'allarme SOLO sulla prenotazione in entrata 
    // (quella il cui check-in corrisponde al check-out di un'altra)
    if (isSameDay(checkInDate, otherCheckOut)) return true;
  }

  return false;
}

export function isPastCheckout(checkOut: string): boolean {
  if (!checkOut) return false;
  const today = startOfDay(new Date());
  const checkoutDate = startOfDay(parseISO(checkOut));
  return isBefore(checkoutDate, today);
}

export function isCheckoutImminent(checkOut: string, advanceDays: number): boolean {
  if (!checkOut) return false;
  const today = startOfDay(new Date());
  const checkoutDate = startOfDay(parseISO(checkOut));
  const diff = differenceInDays(checkoutDate, today);
  return diff >= 0 && diff <= advanceDays;
}
