export interface Reservation {
  id: string;
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
  adults: number;
  children: number;
  portal: string;
  notes: string;
  phone?: string;
}
